// Shared extraction for HTTP method + path questions. Query classification, content prescoring,
// and line matching must recognize the same route syntax so a route cannot be prioritized by one
// retrieval ring and treated as generic prose by another.

const ROUTE_QUERY_PATH_RE = /\/[A-Za-z0-9:_?&=./{}%+*-]*[A-Za-z0-9_}/*-]/u;
const ROOT_ROUTE_QUERY_PATH_RE =
  /(?:\b(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/)(?=\s|[?.,;:]|$)|(?:^|\s)(\/)(?=\s+(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b))/iu;
const ROOT_ROUTE_DECLARATION_PATH_RE = /\/(?=["'`])/u;
const ROUTE_QUERY_METHOD_RE = /\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/iu;
const REPOSITORY_HTTP_METHODS = [
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
] as const;
const ROUTE_DECLARATION_MARKER_PREFIX = "keiko-internal-route-declaration-v2";
export const REPOSITORY_ROUTE_DECLARATION_WINDOW_LINES = 4;
const ROUTE_DECLARATION_START_RE =
  /\b(?:router|app|server|r)\.(?:get|post|put|patch|delete|head|options)\s*\(|\b(?:router|r)\.handlefunc\s*\(|\broute::(?:get|post|put|patch|delete|head|options)\s*\(|@(?:get|post|put|patch|delete|head|options)(?:mapping)?\b|@requestmapping\b|\[\s*route\s*\(|\[\s*http(?:get|post|put|patch|delete|head|options)\s*(?:\(|\])|\bhttp(?:get|post|put|patch|delete|head|options)\s*\(|#\[(?:get|post|put|patch|delete|head|options)\s*\(|\bmap(?:get|post|put|patch|delete|head|options)\s*\(|(?:^|[;{]\s*)(?:get|post|put|patch|delete|head|options)(?:\s*\(|\s+)|\.route\s*\(/giu;
const CONFIGURED_ROUTE_METHOD_RE =
  /["']?method["']?\s*:\s*["']?(get|post|put|patch|delete|head|options)\b/iu;
const CONFIGURED_ROUTE_PATH_RE =
  /["']?(?:path|pattern)["']?\s*:\s*(?:["'](\/(?:[A-Za-z0-9:_?&=./{}%+*-]*[A-Za-z0-9_}/*-])?)["']|(\/(?:[A-Za-z0-9:_?&=./{}%+*-]*[A-Za-z0-9_}/*-])?)(?=\s|,|\}))/iu;
const CONFIGURED_ROUTE_HANDLER_RE = /["']?handler["']?\s*:/iu;
const CONFIGURED_ROUTE_FIELD_RE = /^(?:["']?(?:method|path|pattern|handler)["']?)\s*:/iu;
const YAML_SEQUENCE_ITEM_RE = /^(\s*)-(?:\s+(.*))?$/u;
const SPRING_REQUEST_MAPPING_PATH_RE =
  /\b(?:path|value)\s*=\s*(?:\{\s*)?["'](\/(?:[A-Za-z0-9:_?&=./{}%+*-]*[A-Za-z0-9_}/*-])?)["']/iu;
const SPRING_REQUEST_MAPPING_METHOD_RE =
  /\bmethod\s*=\s*(?:\{\s*)?requestmethod\.(get|post|put|patch|delete|head|options)\b/iu;
const ASP_NET_ROUTE_RE =
  /\[\s*route\s*\(\s*["'](\/(?:[A-Za-z0-9:_?&=./{}%+*-]*[A-Za-z0-9_}/*-])?)["']\s*\)\s*\]/iu;
const ASP_NET_HTTP_METHOD_RE =
  /\[\s*http(get|post|put|patch|delete|head|options)\s*(?:\(\s*["'](\/(?:[A-Za-z0-9:_?&=./{}%+*-]*[A-Za-z0-9_}/*-])?)["']\s*\))?\s*\]/iu;
const RAILS_TO_OPTION_RE = /,\s*to\s*:/iu;

export interface RepositoryRouteQuery {
  readonly path: string;
  readonly method: string;
}

function routeQueryPath(text: string): string | undefined {
  const root = ROOT_ROUTE_QUERY_PATH_RE.exec(text);
  return ROUTE_QUERY_PATH_RE.exec(text)?.[0] ?? root?.[1] ?? root?.[2];
}

function routeDeclarationPath(text: string): string | undefined {
  return ROUTE_QUERY_PATH_RE.exec(text)?.[0] ?? ROOT_ROUTE_DECLARATION_PATH_RE.exec(text)?.[0];
}

export function repositoryRouteQuery(text: string): RepositoryRouteQuery | undefined {
  const path = routeQueryPath(text)?.toLowerCase();
  const method = ROUTE_QUERY_METHOD_RE.exec(text)?.[1]?.toLowerCase();
  return path === undefined || method === undefined ? undefined : { path, method };
}

function routeMethodMatches(haystack: string, method: string): boolean {
  const needles = [
    `.${method}(`,
    `::${method}(`,
    ` ${method}(`,
    `@${method}`,
    `@${method}mapping`,
    `http${method}(`,
    `http${method}]`,
    `#[${method}(`,
    `map${method}(`,
    `methods("${method}"`,
    `methods('${method}'`,
    `methods=["${method}"`,
    `methods=['${method}'`,
    `methods: ["${method}"`,
    `methods: ['${method}'`,
    `methods(http.method${method}`,
  ];
  return (
    haystack.trimStart().startsWith(`${method}(`) ||
    explicitMethodListMatches(haystack, method) ||
    needles.some((needle) => haystack.includes(needle))
  );
}

function explicitMethodListMatches(haystack: string, method: string): boolean {
  const lists = haystack.matchAll(/\bmethods\s*(?:=|:)?\s*(?:\(|\[)([^\])]{0,500})[\])]/giu);
  for (const list of lists) {
    const body = list[1] ?? "";
    if (
      body.includes(`"${method}"`) ||
      body.includes(`'${method}'`) ||
      body.includes(`http.method${method}`)
    ) {
      return true;
    }
  }
  return false;
}

function configuredRouteMethodMatches(haystack: string, method: string): boolean {
  return (
    CONFIGURED_ROUTE_HANDLER_RE.test(haystack) &&
    CONFIGURED_ROUTE_PATH_RE.test(haystack) &&
    CONFIGURED_ROUTE_METHOD_RE.exec(haystack)?.[1]?.toLowerCase() === method
  );
}

function routeShapeMatches(haystack: string, method: string): boolean {
  const configured =
    haystack.includes("handler:") &&
    ["pattern:", "path:", "method:"].some((needle) => haystack.includes(needle));
  const shapes = [
    `router.${method}(`,
    `app.${method}(`,
    `server.${method}(`,
    `r.${method}(`,
    `@${method}(`,
    `@${method}`,
    `@${method}mapping`,
    `http${method}(`,
    `http${method}]`,
    `#[${method}(`,
    `map${method}(`,
    `route::${method}(`,
    "route(",
    "handlefunc(",
  ];
  return (
    configured ||
    haystack.trimStart().startsWith(`${method}(`) ||
    shapes.some((shape) => haystack.includes(shape))
  );
}

function annotationSlice(code: string, structural: string, annotation: string): string | undefined {
  const start = structural.toLowerCase().indexOf(annotation);
  if (start < 0) return undefined;
  const open = structural.indexOf("(", start + annotation.length);
  const close = open < 0 ? -1 : structural.indexOf(")", open + 1);
  return close < 0 ? undefined : code.slice(start, close + 1);
}

function springRequestMappingMarkers(
  code: string,
  structural: string,
): readonly string[] | undefined {
  const annotation = annotationSlice(code, structural, "@requestmapping");
  if (annotation === undefined) {
    return structural.toLowerCase().includes("@requestmapping") ? [] : undefined;
  }
  const path = SPRING_REQUEST_MAPPING_PATH_RE.exec(annotation)?.[1];
  const method = SPRING_REQUEST_MAPPING_METHOD_RE.exec(annotation)?.[1];
  return path === undefined || method === undefined
    ? []
    : [repositoryRouteDeclarationMarker(method, path)];
}

function aspNetRouteMarkers(code: string, structural: string): readonly string[] | undefined {
  const shape = structural.toLowerCase();
  const frameworkShape = /\[\s*(?:route\s*\(|http(?:get|post|put|patch|delete|head|options)\b)/u;
  if (!frameworkShape.test(shape)) return undefined;
  const methodMatch = ASP_NET_HTTP_METHOD_RE.exec(code);
  if (methodMatch === null) return [];
  const separateRoute = ASP_NET_ROUTE_RE.exec(code);
  const separatePath =
    separateRoute !== null && separateRoute.index < methodMatch.index
      ? separateRoute[1]
      : undefined;
  const path = methodMatch[2] ?? separatePath;
  return path === undefined ? [] : [repositoryRouteDeclarationMarker(methodMatch[1] ?? "", path)];
}

function routeBodyStart(text: string): number {
  let cursor = 0;
  while (/\s/u.test(text.charAt(cursor))) cursor += 1;
  if (text.charAt(cursor) === ";" || text.charAt(cursor) === "{") cursor += 1;
  while (/\s/u.test(text.charAt(cursor))) cursor += 1;
  return cursor;
}

function railsRouteMarkers(code: string, structural: string): readonly string[] | undefined {
  const start = routeBodyStart(structural);
  const method = REPOSITORY_HTTP_METHODS.find((candidate) => {
    const end = start + candidate.length;
    return structural.slice(start, end).toLowerCase() === candidate && /\s/u.test(code.charAt(end));
  });
  if (method === undefined) return undefined;
  let cursor = start + method.length;
  while (/\s/u.test(code.charAt(cursor))) cursor += 1;
  const quote = code.charAt(cursor);
  if (quote !== '"' && quote !== "'") return [];
  const close = code.indexOf(quote, cursor + 1);
  if (close < 0) return [];
  const path = code.slice(cursor + 1, close);
  const exactPath = path === "/" || ROUTE_QUERY_PATH_RE.exec(path)?.[0] === path;
  const targetBound = RAILS_TO_OPTION_RE.test(structural.slice(close + 1));
  return exactPath && targetBound ? [repositoryRouteDeclarationMarker(method, path)] : [];
}

function specializedRouteMarkers(code: string, structural: string): readonly string[] | undefined {
  return (
    springRequestMappingMarkers(code, structural) ??
    aspNetRouteMarkers(code, structural) ??
    railsRouteMarkers(code, structural)
  );
}

function configuredRouteMarker(candidate: string): string | undefined {
  if (!CONFIGURED_ROUTE_HANDLER_RE.test(candidate)) return undefined;
  const method = CONFIGURED_ROUTE_METHOD_RE.exec(candidate)?.[1];
  const pathMatch = CONFIGURED_ROUTE_PATH_RE.exec(candidate);
  const path = pathMatch?.[1] ?? pathMatch?.[2];
  return method === undefined || path === undefined
    ? undefined
    : repositoryRouteDeclarationMarker(method, path);
}

function configuredRouteMarkers(code: string, structural: string): readonly string[] {
  const frames: string[][] = [];
  const markers: string[] = [];
  for (let index = 0; index < structural.length; index += 1) {
    const char = structural.charAt(index);
    if (char === "{") {
      frames.push(["{"]);
      continue;
    }
    const frame = frames.at(-1);
    if (char !== "}") {
      frame?.push(code.charAt(index));
      continue;
    }
    frame?.push("}");
    const completed = frames.pop();
    const marker = completed === undefined ? undefined : configuredRouteMarker(completed.join(""));
    if (marker !== undefined) markers.push(marker);
    frames.at(-1)?.push(" ");
  }
  return markers;
}

interface YamlRouteLine {
  readonly code: string;
  readonly structural: string;
}

interface YamlSequenceItem {
  readonly fieldOffset: number | undefined;
  readonly indent: number;
}

function yamlFieldOffset(structural: string, after = 0): number | undefined {
  const field = structural.slice(after).search(/\S/u);
  return field < 0 ? undefined : after + field;
}

function yamlSequenceItem(structural: string): YamlSequenceItem | undefined {
  const match = YAML_SEQUENCE_ITEM_RE.exec(structural);
  if (match === null) return undefined;
  const indent = match[1]?.length ?? 0;
  return { fieldOffset: yamlFieldOffset(structural, indent + 1), indent };
}

function firstYamlFieldOffset(
  lines: readonly YamlRouteLine[],
  startIndex: number,
  item: YamlSequenceItem,
): number | undefined {
  if (item.fieldOffset !== undefined) return item.fieldOffset;
  const endIndex = Math.min(lines.length, startIndex + REPOSITORY_ROUTE_DECLARATION_WINDOW_LINES);
  for (let index = startIndex + 1; index < endIndex; index += 1) {
    const line = lines[index];
    if (line === undefined) return undefined;
    const offset = yamlFieldOffset(line.structural);
    if (offset === undefined) continue;
    return offset > item.indent ? offset : undefined;
  }
  return undefined;
}

function yamlRouteFields(
  lines: readonly YamlRouteLine[],
  startIndex: number,
  item: YamlSequenceItem,
  fieldOffset: number,
): readonly string[] {
  const fields: string[] = [];
  const endIndex = Math.min(lines.length, startIndex + REPOSITORY_ROUTE_DECLARATION_WINDOW_LINES);
  for (let index = startIndex; index < endIndex; index += 1) {
    const line = lines[index];
    if (line === undefined) break;
    const offset = index === startIndex ? item.fieldOffset : yamlFieldOffset(line.structural);
    if (index > startIndex && offset !== undefined && offset <= item.indent) break;
    if (offset !== fieldOffset) continue;
    const structuralField = line.structural.slice(offset);
    if (CONFIGURED_ROUTE_FIELD_RE.test(structuralField)) fields.push(line.code.slice(offset));
  }
  return fields;
}

function yamlRouteCandidate(lines: readonly YamlRouteLine[], startIndex: number): string {
  const start = lines[startIndex];
  if (start === undefined) return "";
  const item = yamlSequenceItem(start.structural);
  if (item === undefined) return "";
  const fieldOffset = firstYamlFieldOffset(lines, startIndex, item);
  return fieldOffset === undefined
    ? ""
    : yamlRouteFields(lines, startIndex, item, fieldOffset).join(" ");
}

function configuredYamlRouteMarkers(code: string, structural: string): readonly string[] {
  const codeLines = code.split(/\r?\n/u);
  const structuralLines = structural.split(/\r?\n/u);
  const lines = codeLines.map((line, index) => ({
    code: line,
    structural: structuralLines[index] ?? "",
  }));
  return lines.flatMap((line, index) => {
    if (!YAML_SEQUENCE_ITEM_RE.test(line.structural)) return [];
    const marker = configuredRouteMarker(yamlRouteCandidate(lines, index));
    return marker === undefined ? [] : [marker];
  });
}

interface RouteSourceSegment {
  readonly code: string;
  readonly line: number;
  readonly startsDeclaration: boolean;
  readonly structural: string;
}

function routeStartOffsets(structural: string): readonly number[] {
  ROUTE_DECLARATION_START_RE.lastIndex = 0;
  return [...structural.matchAll(ROUTE_DECLARATION_START_RE)].map((match) => match.index);
}

function segmentsForLine(
  code: string,
  structural: string,
  line: number,
): readonly RouteSourceSegment[] {
  const offsets = routeStartOffsets(structural);
  if (offsets.length === 0) return [{ code, structural, line, startsDeclaration: false }];
  const boundaries = offsets[0] === 0 ? offsets : [0, ...offsets];
  return boundaries.map((start, index) => {
    const end = boundaries[index + 1] ?? structural.length;
    return {
      code: code.slice(start, end),
      structural: structural.slice(start, end),
      line,
      startsDeclaration: offsets.includes(start),
    };
  });
}

function routeSourceSegments(text: string, shapeText: string): readonly RouteSourceSegment[] {
  const codeLines = text.split(/\r?\n/u);
  const structuralLines = shapeText.split(/\r?\n/u);
  return codeLines.flatMap((code, line) =>
    segmentsForLine(code, structuralLines[line] ?? "", line),
  );
}

function declarationGroup(
  segments: readonly RouteSourceSegment[],
  startIndex: number,
): { readonly code: string; readonly structural: string } {
  const startLine = segments[startIndex]?.line ?? 0;
  const group = [...precedingPathAnnotation(segments, startIndex, startLine)];
  for (let index = startIndex; index < segments.length; index += 1) {
    const segment = segments[index];
    if (
      segment === undefined ||
      segment.line >= startLine + REPOSITORY_ROUTE_DECLARATION_WINDOW_LINES
    ) {
      break;
    }
    if (index > startIndex && segment.startsDeclaration) break;
    group.push(segment);
  }
  return {
    code: group.map((segment) => segment.code).join(" "),
    structural: group.map((segment) => segment.structural).join(" "),
  };
}

function pathAnnotationSyntax(text: string): boolean {
  return /@path\s*\(|\[\s*route\s*\(/iu.test(text);
}

function nonAttributeSyntax(text: string): boolean {
  return text.length > 0 && !text.startsWith("@") && !text.startsWith("[");
}

function precedingPathAnnotation(
  segments: readonly RouteSourceSegment[],
  startIndex: number,
  startLine: number,
): readonly RouteSourceSegment[] {
  if (routeDeclarationPath(segments[startIndex]?.code ?? "") !== undefined) return [];
  for (let index = startIndex - 1; index >= 0; index -= 1) {
    const segment = segments[index];
    if (segment === undefined) break;
    if (segment.line <= startLine - REPOSITORY_ROUTE_DECLARATION_WINDOW_LINES) break;
    const trimmed = segment.structural.trim();
    if (pathAnnotationSyntax(trimmed)) return [segment];
    if (segment.startsDeclaration) break;
    if (nonAttributeSyntax(trimmed)) break;
  }
  return [];
}

function declarationMarkers(code: string, structural: string): readonly string[] {
  const specialized = specializedRouteMarkers(code, structural);
  if (specialized !== undefined) return specialized;
  const path = routeDeclarationPath(code);
  if (path === undefined) return [];
  return REPOSITORY_HTTP_METHODS.filter((method) =>
    repositoryRouteDeclarationMatches(code, method, structural),
  ).map((method) => repositoryRouteDeclarationMarker(method, path));
}

export function repositoryRouteDeclarationMatches(
  text: string,
  method: string,
  shapeText = text,
): boolean {
  const normalizedMethod = method.toLowerCase();
  const specialized = specializedRouteMarkers(text, shapeText);
  if (specialized !== undefined) {
    return specialized.some((marker) =>
      marker.startsWith(`${ROUTE_DECLARATION_MARKER_PREFIX}:${normalizedMethod}:`),
    );
  }
  const haystack = text.toLowerCase();
  const shapeHaystack = shapeText.toLowerCase();
  return (
    configuredRouteMethodMatches(haystack, normalizedMethod) ||
    (routeMethodMatches(haystack, normalizedMethod) &&
      routeShapeMatches(shapeHaystack, normalizedMethod))
  );
}

export function repositoryRouteDeclarationMarker(method: string, path: string): string {
  return `${ROUTE_DECLARATION_MARKER_PREFIX}:${method.toLowerCase()}:${path.toLowerCase()}`;
}

export function repositoryRouteDeclarationMarkers(
  text: string,
  shapeText = text,
): readonly string[] {
  const segments = routeSourceSegments(text, shapeText);
  const markers = new Set([
    ...configuredRouteMarkers(text, shapeText),
    ...configuredYamlRouteMarkers(text, shapeText),
  ]);
  for (let index = 0; index < segments.length; index += 1) {
    if (segments[index]?.startsDeclaration !== true) continue;
    const group = declarationGroup(segments, index);
    for (const marker of declarationMarkers(group.code, group.structural)) markers.add(marker);
  }
  return [...markers];
}
