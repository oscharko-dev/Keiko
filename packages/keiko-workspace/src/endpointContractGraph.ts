import { posix as path } from "node:path";
import type { WorkspaceFs } from "./fs.js";
import type { SearchLimits, SearchScope } from "./repoSearch.js";
import type {
  EndpointClientCallContract,
  EndpointClientKind,
  EndpointContractGraph,
  EndpointContractLink,
  EndpointDtoEvidence,
  EndpointDtoShape,
  EndpointHttpMethod,
  EndpointRouteContract,
} from "./endpointContractTypes.js";
import {
  hashEndpointContractId,
  joinEndpointPaths,
  lineNumberOf,
  normalizeEndpointPath,
  unquote,
} from "./endpointContractPaths.js";
import { endpointSourceFiles, type SourceFile } from "./endpointContractSource.js";

interface EndpointBuildState {
  readonly routes: EndpointRouteContract[];
  readonly clientCalls: EndpointClientCallContract[];
  readonly dtoShapes: EndpointDtoShape[];
  filesScanned: number;
}

const HTTP_METHODS = new Set<EndpointHttpMethod>(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const SPRING_METHODS: Readonly<Record<string, EndpointHttpMethod>> = {
  GetMapping: "GET",
  PostMapping: "POST",
  PutMapping: "PUT",
  PatchMapping: "PATCH",
  DeleteMapping: "DELETE",
};
const JAVA_ROUTE =
  /@(GetMapping|PostMapping|PutMapping|PatchMapping|DeleteMapping|RequestMapping)\s*(?:\(([^)]*)\))?[\s\r\n]*(?:public|private|protected)?\s*([\w.<>?]+)\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/gu;
const JAVA_RECORD = /\brecord\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/gu;
const TS_INTERFACE = /\binterface\s+([A-Za-z_$][\w$]*)\s*\{([^}]*)\}/gu;
const TS_TYPE_OBJECT = /\btype\s+([A-Za-z_$][\w$]*)\s*=\s*\{([^}]*)\}/gu;
const AXIOS_CALL =
  /\baxios\.(get|post|put|patch|delete)\s*(?:<\s*([A-Za-z_$][\w$]*)\s*>)?\s*\(\s*(`(?:[^`\\]|\\.)*`|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/gu;
const FETCH_CALL =
  /\bfetch\s*\(\s*(`(?:[^`\\]|\\.)*`|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")(?:\s*,\s*\{([\s\S]{0,300}?)\})?/gu;

function firstStringLiteral(args: string | undefined): string {
  if (args === undefined) return "/";
  const match = /(?:path|value)?\s*=?\s*(["'])([^"']+)\1/u.exec(args);
  return match?.[2] ?? "/";
}

function requestMappingMethod(args: string | undefined): EndpointHttpMethod {
  const method = /RequestMethod\.(GET|POST|PUT|PATCH|DELETE)\b/u.exec(args ?? "")?.[1];
  return HTTP_METHODS.has(method as EndpointHttpMethod) ? (method as EndpointHttpMethod) : "GET";
}

function springMethod(annotation: string, args: string | undefined): EndpointHttpMethod {
  return SPRING_METHODS[annotation] ?? requestMappingMethod(args);
}

function routeBasePath(text: string): string {
  const match = /@RequestMapping\s*\(([^)]*)\)[\s\S]{0,240}?\bclass\s+[A-Za-z_$][\w$]*/u.exec(text);
  return normalizeEndpointPath(firstStringLiteral(match?.[1]));
}

function unwrapType(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const clean = raw.replace(/\?/gu, "").trim();
  if (
    /^(void|Void|String|boolean|Boolean|int|long|double|float|Integer|Long|Double)$/u.test(clean)
  ) {
    return undefined;
  }
  const generic = /<\s*([A-Za-z_$][\w$]*)\s*>/u.exec(clean)?.[1];
  return generic ?? (/^[A-Za-z_$][\w$]*$/u.test(clean) ? clean : undefined);
}

function requestBodyType(params: string): string | undefined {
  return /@RequestBody\s+([A-Za-z_$][\w$]*(?:<[^>]+>)?)\s+[A-Za-z_$][\w$]*/u.exec(params)?.[1];
}

function addRoute(state: EndpointBuildState, file: SourceFile, match: RegExpExecArray): void {
  const method = springMethod(match[1] ?? "RequestMapping", match[2]);
  const routePath = joinEndpointPaths(routeBasePath(file.text), firstStringLiteral(match[2]));
  const line = lineNumberOf(file.text, match.index);
  const responseType = unwrapType(match[3]);
  const requestType = unwrapType(requestBodyType(match[5] ?? ""));
  state.routes.push({
    stableId: hashEndpointContractId("ec-route", [method, routePath, file.scopePath, line]),
    method,
    path: routePath,
    normalizedPath: normalizeEndpointPath(routePath),
    scopePath: file.scopePath,
    line,
    framework: "spring",
    handler: match[4],
    requestType,
    responseType,
    confidence: 0.92,
  });
}

function javaFieldNames(fields: string): readonly string[] {
  return fields
    .split(",")
    .map((entry) => /([A-Za-z_$][\w$]*)\s*$/u.exec(entry.trim())?.[1])
    .filter((field): field is string => field !== undefined)
    .sort((a, b) => a.localeCompare(b));
}

function tsFieldNames(fields: string): readonly string[] {
  const out: string[] = [];
  const regex = /\b([A-Za-z_$][\w$]*)\??\s*:/gu;
  let match: RegExpExecArray | null = regex.exec(fields);
  while (match !== null) {
    if (match[1] !== undefined) out.push(match[1]);
    match = regex.exec(fields);
  }
  return [...new Set(out)].sort((a, b) => a.localeCompare(b));
}

function addDtoShape(
  state: EndpointBuildState,
  file: SourceFile,
  language: EndpointDtoShape["language"],
  typeName: string,
  line: number,
  fields: readonly string[],
): void {
  state.dtoShapes.push({
    stableId: hashEndpointContractId("ec-dto", [language, typeName, file.scopePath, line]),
    typeName,
    scopePath: file.scopePath,
    line,
    fields,
    language,
  });
}

function extractJava(file: SourceFile, state: EndpointBuildState): void {
  JAVA_ROUTE.lastIndex = 0;
  let route: RegExpExecArray | null = JAVA_ROUTE.exec(file.text);
  while (route !== null) {
    addRoute(state, file, route);
    route = JAVA_ROUTE.exec(file.text);
  }
  JAVA_RECORD.lastIndex = 0;
  let dto: RegExpExecArray | null = JAVA_RECORD.exec(file.text);
  while (dto !== null) {
    addDtoShape(
      state,
      file,
      "java",
      dto[1] ?? "",
      lineNumberOf(file.text, dto.index),
      javaFieldNames(dto[2] ?? ""),
    );
    dto = JAVA_RECORD.exec(file.text);
  }
}

function methodFromOptions(options: string | undefined): EndpointHttpMethod {
  const raw = /\bmethod\s*:\s*["'](GET|POST|PUT|PATCH|DELETE)["']/iu.exec(options ?? "")?.[1];
  return HTTP_METHODS.has(raw?.toUpperCase() as EndpointHttpMethod)
    ? (raw?.toUpperCase() as EndpointHttpMethod)
    : "GET";
}

function addClientCall(
  state: EndpointBuildState,
  file: SourceFile,
  client: EndpointClientKind,
  method: EndpointHttpMethod,
  literal: string,
  line: number,
  responseType: string | undefined,
): void {
  const rawPath = unquote(literal);
  const normalizedPath = normalizeEndpointPath(rawPath);
  state.clientCalls.push({
    stableId: hashEndpointContractId("ec-client", [
      client,
      method,
      normalizedPath,
      file.scopePath,
      line,
    ]),
    method,
    path: rawPath,
    normalizedPath,
    scopePath: file.scopePath,
    line,
    client,
    responseType,
    confidence: client === "axios" ? 0.86 : 0.78,
  });
}

function extractTypeScript(file: SourceFile, state: EndpointBuildState): void {
  AXIOS_CALL.lastIndex = 0;
  let axios: RegExpExecArray | null = AXIOS_CALL.exec(file.text);
  while (axios !== null) {
    addClientCall(
      state,
      file,
      "axios",
      (axios[1] ?? "get").toUpperCase() as EndpointHttpMethod,
      axios[3] ?? "",
      lineNumberOf(file.text, axios.index),
      axios[2],
    );
    axios = AXIOS_CALL.exec(file.text);
  }
  FETCH_CALL.lastIndex = 0;
  let fetchCall: RegExpExecArray | null = FETCH_CALL.exec(file.text);
  while (fetchCall !== null) {
    addClientCall(
      state,
      file,
      "fetch",
      methodFromOptions(fetchCall[2]),
      fetchCall[1] ?? "",
      lineNumberOf(file.text, fetchCall.index),
      undefined,
    );
    fetchCall = FETCH_CALL.exec(file.text);
  }
  extractTsDtos(file, state);
}

function extractTsDtos(file: SourceFile, state: EndpointBuildState): void {
  for (const regex of [TS_INTERFACE, TS_TYPE_OBJECT]) {
    regex.lastIndex = 0;
    let dto: RegExpExecArray | null = regex.exec(file.text);
    while (dto !== null) {
      addDtoShape(
        state,
        file,
        "typescript",
        dto[1] ?? "",
        lineNumberOf(file.text, dto.index),
        tsFieldNames(dto[2] ?? ""),
      );
      dto = regex.exec(file.text);
    }
  }
}

function dtoEvidence(
  route: EndpointRouteContract,
  call: EndpointClientCallContract,
  shapes: readonly EndpointDtoShape[],
): EndpointDtoEvidence | undefined {
  const serverType = route.responseType ?? route.requestType;
  const clientType = call.responseType;
  if (serverType === undefined || clientType === undefined) return undefined;
  const server = shapes.find((shape) => shape.language === "java" && shape.typeName === serverType);
  const client = shapes.find(
    (shape) => shape.language === "typescript" && shape.typeName === clientType,
  );
  if (server === undefined || client === undefined) return undefined;
  const shared = server.fields.filter((field) => client.fields.includes(field));
  const confidence =
    server.fields.length === 0 ? 0.4 : Number((shared.length / server.fields.length).toFixed(3));
  return {
    serverType,
    clientType,
    sharedFields: shared,
    serverOnlyFields: server.fields.filter((field) => !client.fields.includes(field)),
    clientOnlyFields: client.fields.filter((field) => !server.fields.includes(field)),
    confidence: shared.length === 0 ? 0.4 : confidence,
  };
}

function linkConfidence(
  route: EndpointRouteContract,
  call: EndpointClientCallContract,
  ambiguous: boolean,
  dto: EndpointDtoEvidence | undefined,
): number {
  const base = route.confidence * call.confidence * (ambiguous ? 0.68 : 1);
  const dtoBoost = dto === undefined ? 0 : Math.min(dto.confidence, 1) * 0.08;
  return Number(Math.min(0.99, base + dtoBoost).toFixed(3));
}

function buildLinks(
  routes: readonly EndpointRouteContract[],
  calls: readonly EndpointClientCallContract[],
  shapes: readonly EndpointDtoShape[],
): {
  readonly links: readonly EndpointContractLink[];
  readonly unmatchedRoutes: readonly EndpointRouteContract[];
  readonly ambiguousClientCalls: readonly EndpointClientCallContract[];
} {
  const links: EndpointContractLink[] = [];
  const unmatchedRoutes: EndpointRouteContract[] = [];
  const ambiguousClientCalls: EndpointClientCallContract[] = [];
  for (const route of routes) {
    const matches = calls.filter(
      (call) => call.method === route.method && call.normalizedPath === route.normalizedPath,
    );
    if (matches.length === 0) {
      unmatchedRoutes.push(route);
      continue;
    }
    const ambiguous = matches.length > 1;
    if (ambiguous) ambiguousClientCalls.push(...matches);
    for (const call of matches) {
      const dto = dtoEvidence(route, call, shapes);
      links.push({
        stableId: hashEndpointContractId("ec-link", [route.stableId, call.stableId, ambiguous]),
        method: route.method,
        normalizedPath: route.normalizedPath,
        route,
        clientCall: call,
        confidence: linkConfidence(route, call, ambiguous, dto),
        ambiguous,
        dtoEvidence: dto,
      });
    }
  }
  return { links, unmatchedRoutes, ambiguousClientCalls };
}

function addSourceRecords(file: SourceFile, state: EndpointBuildState): void {
  state.filesScanned += 1;
  if (path.extname(file.scopePath).toLowerCase() === ".java") {
    extractJava(file, state);
  } else {
    extractTypeScript(file, state);
  }
}

export async function buildEndpointContractGraph(
  scope: SearchScope,
  limits: SearchLimits,
  fs: WorkspaceFs,
): Promise<EndpointContractGraph> {
  const state: EndpointBuildState = { routes: [], clientCalls: [], dtoShapes: [], filesScanned: 0 };
  for (const file of await endpointSourceFiles(scope, limits, fs)) {
    addSourceRecords(file, state);
  }
  const linked = buildLinks(state.routes, state.clientCalls, state.dtoShapes);
  return {
    routes: state.routes,
    clientCalls: state.clientCalls,
    dtoShapes: state.dtoShapes,
    links: linked.links,
    unmatchedRoutes: linked.unmatchedRoutes,
    ambiguousClientCalls: linked.ambiguousClientCalls,
    diagnostics: {
      filesScanned: state.filesScanned,
      routesFound: state.routes.length,
      clientCallsFound: state.clientCalls.length,
      linksFound: linked.links.length,
      ambiguousClientCalls: linked.ambiguousClientCalls.length,
      unmatchedRoutes: linked.unmatchedRoutes.length,
    },
  };
}
