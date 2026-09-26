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
  createStructuralExecutionControl,
  structuralExecutionStopped,
  type StructuralExecutionControl,
} from "./structuralExecution.js";
import {
  hashEndpointContractId,
  joinEndpointPaths,
  lineNumberOf,
  normalizeEndpointPath,
  unquote,
} from "./endpointContractPaths.js";
import { endpointSourceFileSetFromCandidates, type SourceFile } from "./endpointContractSource.js";
import { gatherCandidatesWithControl, type CandidateSet } from "./repoSearchScan.js";

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
// The whitespace runs around the two optional segments (annotation args, access modifier) are
// bounded ({0,200}) rather than unbounded (`\s*`) so a crafted run of whitespace between the
// annotation and the method signature cannot make three adjacent quantifiers backtrack against
// each other with polynomial cost (typescript:S8786). 200 chars comfortably covers any
// realistically formatted Java source gap.
//
// The annotation name used to be a 6-branch alternation
// (GetMapping|PostMapping|PutMapping|PatchMapping|DeleteMapping|RequestMapping); combined with
// the rest of this regex's structure, that pushed it over SonarCloud S5843's complexity
// threshold. `[A-Za-z]+Mapping` matches the same shape generically (a Spring annotation name
// always ends in "Mapping"), and JAVA_ANNOTATION_NAMES below gates which captured names actually
// produce a route — extractJava only calls addRoute when the captured name is one of the 6 known
// annotations, exactly reproducing the original alternation's accept/reject set. An unrecognized
// "...Mapping" annotation can still structurally match this regex where the literal alternation
// never would have, but since it's rejected before addRoute either way, the observable output
// (the routes actually extracted) is unchanged.
const JAVA_ANNOTATION_NAMES: ReadonlySet<string> = new Set([
  "GetMapping",
  "PostMapping",
  "PutMapping",
  "PatchMapping",
  "DeleteMapping",
  "RequestMapping",
]);
// Split from one regex (annotation + optional access-modifier alternation + signature, all in
// one pattern) into an annotation-scan regex, a plain-code optional-modifier skip, and a
// signature regex (typescript:S5843 — the combined form was still over the complexity threshold).
// A modifier-then-type ambiguity rules out folding the modifier back in as a second optional
// identifier group in the signature regex: since "public" and a real return type are both bare
// identifiers, an ambiguous optional-identifier-then-identifier shape would force the same kind
// of backtracking the split is meant to remove. Checking the modifier via a plain Set membership
// test instead (mirrors csharpPropertyFieldName's approach above) has no such ambiguity.
const JAVA_ANNOTATION_RE = /@([A-Za-z]+Mapping)\s{0,200}(?:\(([^)]*)\))?\s{0,200}/gu;
const JAVA_MODIFIERS: ReadonlySet<string> = new Set(["public", "private", "protected"]);
const JAVA_SIGNATURE_RE = /^([\w.<>?]+)\s+([A-Za-z_$][\w$]*)\s{0,200}\(([^)]*)\)/u;

function skipOptionalJavaModifier(text: string): string {
  const match = /^([A-Za-z_$][\w$]*)\s{0,200}/u.exec(text);
  if (match === null || !JAVA_MODIFIERS.has(match[1] ?? "")) {
    return text;
  }
  return text.slice(match[0].length);
}
const JAVA_RECORD = /\brecord\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/gu;
const TS_INTERFACE = /\binterface\s+([A-Za-z_$][\w$]*)\s*\{([^}]*)\}/gu;
const TS_TYPE_OBJECT = /\btype\s+([A-Za-z_$][\w$]*)\s*=\s*\{([^}]*)\}/gu;
// Same fix as JAVA_ROUTE: bound the whitespace runs around the optional generic-type argument so
// the two adjacent `\s*` atoms (before/after the optional `<Type>`) cannot backtrack against each
// other across an attacker-controlled whitespace run (typescript:S8786).
//
// The original AXIOS_CALL combined this call-site prefix (method alternation + optional generic
// arg) with the quoted-string-literal alternation now in STRING_LITERAL_RE; combined, the two
// alternations (5 branches here, 3 more-deeply-nested branches there) crossed SonarCloud S5843's
// complexity threshold even though FETCH_CALL's use of the identical literal alternation alone
// does not. Splitting the literal out into its own regex, applied to the text immediately
// following each AXIOS_CALL_PREFIX match, is behaviourally identical to the original single
// regex: extractTypeScript's exec loop already only advances past a successful prefix match
// either way, and a prefix match whose first argument isn't a quoted literal (e.g.
// `axios.get(someVar)`) is skipped exactly like the original's whole-match failure was.
const AXIOS_CALL_PREFIX =
  /\baxios\.(get|post|put|patch|delete)\s{0,50}(?:<\s*([A-Za-z_$][\w$]*)\s*>)?\s{0,50}\(\s*/gu;
const STRING_LITERAL_RE = /^(?:`(?:[^`\\]|\\.)*`|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/u;
const FETCH_CALL_PREFIX = /\bfetch\s*\(\s*/gu;
const FETCH_OPTIONS_RE = /^\s*,\s*\{([\s\S]{0,300}?)\}/u;

function firstStringLiteral(args: string | undefined): string {
  if (args === undefined) return "/";
  // Bound the whitespace runs around the optional `=` (e.g. `path = "/x"` vs `"/x"`) so the two
  // adjacent `\s*` atoms cannot backtrack against each other over a long non-matching input
  // (typescript:S8786). Real annotation-argument gaps are a handful of characters at most.
  const match = /(?:path|value)?\s{0,20}=?\s{0,20}(["'])([^"']+)\1/u.exec(args);
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
  const clean = raw.replaceAll("?", "").trim();
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

function addRoute(
  state: EndpointBuildState,
  file: SourceFile,
  annotationMatch: RegExpExecArray,
  signatureMatch: RegExpExecArray,
): void {
  const method = springMethod(annotationMatch[1] ?? "RequestMapping", annotationMatch[2]);
  const routePath = joinEndpointPaths(
    routeBasePath(file.text),
    firstStringLiteral(annotationMatch[2]),
  );
  const line = lineNumberOf(file.text, annotationMatch.index);
  const responseType = unwrapType(signatureMatch[1]);
  const requestType = unwrapType(requestBodyType(signatureMatch[3] ?? ""));
  state.routes.push({
    stableId: hashEndpointContractId("ec-route", [method, routePath, file.scopePath, line]),
    method,
    path: routePath,
    normalizedPath: normalizeEndpointPath(routePath),
    scopePath: file.scopePath,
    line,
    framework: "spring",
    handler: signatureMatch[2],
    requestType,
    responseType,
    confidence: 0.92,
  });
}

const IDENT_START = /[A-Za-z_$]/u;
const IDENT_PART = /[\w$]/u;

// Extracts the field/parameter name trailing a Java type (e.g. "String status" -> "status").
// Written as a plain backward-then-forward character scan instead of an unanchored
// `/([A-Za-z_$][\w$]*)\s*$/` regex: that pattern has no `^` anchor, so a non-matching entry (one
// that doesn't end in an identifier) forces `.exec` to retry the match at every offset, each
// retry rescanning the remaining suffix - O(n^2) on a crafted entry (typescript:S8786). The scan
// below visits each character at most twice, so it is linear regardless of input shape.
function trailingIdentifier(text: string): string | undefined {
  const end = text.length;
  let runStart = end;
  while (runStart > 0 && IDENT_PART.test(text[runStart - 1] ?? "")) {
    runStart -= 1;
  }
  for (let index = runStart; index < end; index += 1) {
    if (IDENT_START.test(text[index] ?? "")) {
      return text.slice(index, end);
    }
  }
  return undefined;
}

function javaFieldNames(fields: string): readonly string[] {
  return fields
    .split(",")
    .map((entry) => trailingIdentifier(entry.trim()))
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
  JAVA_ANNOTATION_RE.lastIndex = 0;
  let annotationMatch: RegExpExecArray | null = JAVA_ANNOTATION_RE.exec(file.text);
  while (annotationMatch !== null) {
    if (JAVA_ANNOTATION_NAMES.has(annotationMatch[1] ?? "")) {
      const afterAnnotation = file.text.slice(annotationMatch.index + annotationMatch[0].length);
      const signatureMatch = JAVA_SIGNATURE_RE.exec(skipOptionalJavaModifier(afterAnnotation));
      if (signatureMatch !== null) {
        addRoute(state, file, annotationMatch, signatureMatch);
      }
    }
    annotationMatch = JAVA_ANNOTATION_RE.exec(file.text);
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

function extractAxiosCalls(file: SourceFile, state: EndpointBuildState): void {
  AXIOS_CALL_PREFIX.lastIndex = 0;
  let prefix: RegExpExecArray | null = AXIOS_CALL_PREFIX.exec(file.text);
  while (prefix !== null) {
    const literalMatch = STRING_LITERAL_RE.exec(file.text.slice(prefix.index + prefix[0].length));
    if (literalMatch !== null) {
      addClientCall(
        state,
        file,
        "axios",
        (prefix[1] ?? "get").toUpperCase() as EndpointHttpMethod,
        literalMatch[0],
        lineNumberOf(file.text, prefix.index),
        prefix[2],
      );
    }
    prefix = AXIOS_CALL_PREFIX.exec(file.text);
  }
}

function extractFetchCalls(file: SourceFile, state: EndpointBuildState): void {
  FETCH_CALL_PREFIX.lastIndex = 0;
  let prefix: RegExpExecArray | null = FETCH_CALL_PREFIX.exec(file.text);
  while (prefix !== null) {
    const afterPrefix = file.text.slice(prefix.index + prefix[0].length);
    const literal = STRING_LITERAL_RE.exec(afterPrefix)?.[0];
    if (literal !== undefined) {
      const afterLiteral = afterPrefix.slice(literal.length);
      addClientCall(
        state,
        file,
        "fetch",
        methodFromOptions(FETCH_OPTIONS_RE.exec(afterLiteral)?.[1]),
        literal,
        lineNumberOf(file.text, prefix.index),
        undefined,
      );
    }
    prefix = FETCH_CALL_PREFIX.exec(file.text);
  }
}

function extractTypeScript(file: SourceFile, state: EndpointBuildState): void {
  extractAxiosCalls(file, state);
  extractFetchCalls(file, state);
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

interface MatchingClientCalls {
  readonly calls: readonly EndpointClientCallContract[];
  readonly truncated: boolean;
}

function matchingClientCalls(
  route: EndpointRouteContract,
  calls: readonly EndpointClientCallContract[],
  control: StructuralExecutionControl,
): MatchingClientCalls {
  const matches: EndpointClientCallContract[] = [];
  for (const call of calls) {
    if (structuralExecutionStopped(control)) return { calls: matches, truncated: true };
    if (call.method === route.method && call.normalizedPath === route.normalizedPath) {
      matches.push(call);
    }
  }
  return { calls: matches, truncated: false };
}

function linksForRoute(
  route: EndpointRouteContract,
  calls: readonly EndpointClientCallContract[],
  shapes: readonly EndpointDtoShape[],
  control: StructuralExecutionControl,
): { readonly links: readonly EndpointContractLink[]; readonly truncated: boolean } {
  const links: EndpointContractLink[] = [];
  const ambiguous = calls.length > 1;
  for (const call of calls) {
    if (structuralExecutionStopped(control)) return { links, truncated: true };
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
  return { links, truncated: false };
}

function buildLinks(
  routes: readonly EndpointRouteContract[],
  calls: readonly EndpointClientCallContract[],
  shapes: readonly EndpointDtoShape[],
  control: StructuralExecutionControl,
): {
  readonly links: readonly EndpointContractLink[];
  readonly unmatchedRoutes: readonly EndpointRouteContract[];
  readonly ambiguousClientCalls: readonly EndpointClientCallContract[];
  readonly truncated: boolean;
} {
  const links: EndpointContractLink[] = [];
  const unmatchedRoutes: EndpointRouteContract[] = [];
  const ambiguousClientCalls: EndpointClientCallContract[] = [];
  for (const route of routes) {
    if (structuralExecutionStopped(control)) {
      return { links, unmatchedRoutes, ambiguousClientCalls, truncated: true };
    }
    const matches = matchingClientCalls(route, calls, control);
    if (matches.truncated) {
      return { links, unmatchedRoutes, ambiguousClientCalls, truncated: true };
    }
    if (matches.calls.length === 0) {
      unmatchedRoutes.push(route);
      continue;
    }
    if (matches.calls.length > 1) ambiguousClientCalls.push(...matches.calls);
    const routeLinks = linksForRoute(route, matches.calls, shapes, control);
    links.push(...routeLinks.links);
    if (routeLinks.truncated) {
      return { links, unmatchedRoutes, ambiguousClientCalls, truncated: true };
    }
  }
  return { links, unmatchedRoutes, ambiguousClientCalls, truncated: false };
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
  executionControl?: StructuralExecutionControl,
): Promise<EndpointContractGraph> {
  const control =
    executionControl ?? createStructuralExecutionControl(limits.elapsedMsMax, Date.now);
  return buildEndpointContractGraphFromCandidates(
    scope,
    limits,
    fs,
    gatherCandidatesWithControl(scope, limits, fs, control),
    control,
  );
}

export async function buildEndpointContractGraphFromCandidates(
  scope: SearchScope,
  limits: SearchLimits,
  fs: WorkspaceFs,
  candidateSet: CandidateSet,
  executionControl?: StructuralExecutionControl,
): Promise<EndpointContractGraph> {
  const control =
    executionControl ?? createStructuralExecutionControl(limits.elapsedMsMax, Date.now);
  const sourceSet = await endpointSourceFileSetFromCandidates(
    scope,
    limits,
    fs,
    candidateSet,
    control,
  );
  return buildEndpointContractGraphFromSources(
    sourceSet.files,
    sourceSet.filesSkipped,
    sourceSet.candidateLimitReached,
    control,
  );
}

function buildEndpointContractGraphFromSources(
  files: readonly SourceFile[],
  filesSkipped: number,
  candidateLimitReached: boolean,
  control: StructuralExecutionControl,
): EndpointContractGraph {
  const state: EndpointBuildState = { routes: [], clientCalls: [], dtoShapes: [], filesScanned: 0 };
  let executionTruncated = false;
  for (const file of files) {
    if (structuralExecutionStopped(control)) {
      executionTruncated = true;
      break;
    }
    addSourceRecords(file, state);
    if (structuralExecutionStopped(control)) executionTruncated = true;
    if (executionTruncated) break;
  }
  const linked = buildLinks(state.routes, state.clientCalls, state.dtoShapes, control);
  if (linked.truncated || structuralExecutionStopped(control)) executionTruncated = true;
  return {
    routes: state.routes,
    clientCalls: state.clientCalls,
    dtoShapes: state.dtoShapes,
    links: linked.links,
    unmatchedRoutes: linked.unmatchedRoutes,
    ambiguousClientCalls: linked.ambiguousClientCalls,
    diagnostics: {
      filesScanned: state.filesScanned,
      filesSkipped,
      candidateLimitReached: candidateLimitReached || executionTruncated,
      routesFound: state.routes.length,
      clientCallsFound: state.clientCalls.length,
      linksFound: linked.links.length,
      ambiguousClientCalls: linked.ambiguousClientCalls.length,
      unmatchedRoutes: linked.unmatchedRoutes.length,
    },
  };
}
