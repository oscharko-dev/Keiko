export type EndpointHttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type EndpointServerFramework = "spring";
export type EndpointClientKind = "fetch" | "axios";

export interface EndpointDtoShape {
  readonly stableId: string;
  readonly typeName: string;
  readonly scopePath: string;
  readonly line: number;
  readonly fields: readonly string[];
  readonly language: "java" | "typescript";
}

export interface EndpointRouteContract {
  readonly stableId: string;
  readonly method: EndpointHttpMethod;
  readonly path: string;
  readonly normalizedPath: string;
  readonly scopePath: string;
  readonly line: number;
  readonly framework: EndpointServerFramework;
  readonly handler: string | undefined;
  readonly requestType: string | undefined;
  readonly responseType: string | undefined;
  readonly confidence: number;
}

export interface EndpointClientCallContract {
  readonly stableId: string;
  readonly method: EndpointHttpMethod;
  readonly path: string;
  readonly normalizedPath: string;
  readonly scopePath: string;
  readonly line: number;
  readonly client: EndpointClientKind;
  readonly responseType: string | undefined;
  readonly confidence: number;
}

export interface EndpointDtoEvidence {
  readonly serverType: string;
  readonly clientType: string;
  readonly sharedFields: readonly string[];
  readonly serverOnlyFields: readonly string[];
  readonly clientOnlyFields: readonly string[];
  readonly confidence: number;
}

export interface EndpointContractLink {
  readonly stableId: string;
  readonly method: EndpointHttpMethod;
  readonly normalizedPath: string;
  readonly route: EndpointRouteContract;
  readonly clientCall: EndpointClientCallContract;
  readonly confidence: number;
  readonly ambiguous: boolean;
  readonly dtoEvidence: EndpointDtoEvidence | undefined;
}

export interface EndpointContractDiagnostics {
  readonly filesScanned: number;
  readonly routesFound: number;
  readonly clientCallsFound: number;
  readonly linksFound: number;
  readonly ambiguousClientCalls: number;
  readonly unmatchedRoutes: number;
}

export interface EndpointContractGraph {
  readonly routes: readonly EndpointRouteContract[];
  readonly clientCalls: readonly EndpointClientCallContract[];
  readonly dtoShapes: readonly EndpointDtoShape[];
  readonly links: readonly EndpointContractLink[];
  readonly unmatchedRoutes: readonly EndpointRouteContract[];
  readonly ambiguousClientCalls: readonly EndpointClientCallContract[];
  readonly diagnostics: EndpointContractDiagnostics;
}
