// Language recognition and enclosing-header detection of the review diff package (Issue #4134).

import { describe, expect, it } from "vitest";
import type { ReviewDiffLanguage } from "@oscharko-dev/keiko-contracts";
import { isEnclosingHeader, reviewDiffLanguage } from "./languages.js";

const HEADERS: readonly (readonly [ReviewDiffLanguage, string])[] = [
  ["typescript", "export async function load(id: string): Promise<void> {"],
  ["typescript", "export default class Store<T> extends Base {"],
  ["typescript", "  private async fetch(url: string): Promise<Response> {"],
  ["typescript", "export const handler = async (event: Event) => {"],
  ["typescript", "interface Shape {"],
  ["javascript", "function* walk(node) {"],
  ["javascript", "  render() {"],
  ["python", "async def fetch(self, url):"],
  ["python", "class Parser(Base):"],
  ["java", "public static void main(String[] args) {"],
  ["java", "public final class Service implements Runnable {"],
  ["go", "func (s *Server) Serve(ctx context.Context) error {"],
  ["go", "type Config struct {"],
  ["csharp", "public async Task<int> RunAsync(CancellationToken token) {"],
  ["csharp", "internal sealed record Person(string Name) {"],
  ["kotlin", "override suspend fun load(id: String): User {"],
  ["kotlin", "data class Point(val x: Int, val y: Int)"],
];

const NOT_HEADERS: readonly (readonly [ReviewDiffLanguage, string])[] = [
  ["typescript", "  if (ready) {"],
  ["typescript", "  } else if (other) {"],
  ["typescript", "  items.forEach((item) => {"],
  ["typescript", "  const total = compute(a, b);"],
  ["java", "    for (int i = 0; i < n; i++) {"],
  ["java", "    Foo foo = new Foo(bar) {"],
  ["csharp", "    using (var stream = Open()) {"],
  ["python", "    return value"],
  ["go", "\tif err != nil {"],
  ["rust", "fn main() {"],
  ["typescript", `function ${"x".repeat(500)}() {`],
];

describe("isEnclosingHeader", () => {
  it.each(HEADERS)("recognizes a %s header: %s", (language, line) => {
    expect(isEnclosingHeader(language, line)).toBe(true);
  });

  it.each(NOT_HEADERS)("rejects a %s non-header: %s", (language, line) => {
    expect(isEnclosingHeader(language, line)).toBe(false);
  });
});

describe("reviewDiffLanguage", () => {
  it("maps file names case-insensitively and falls back to other", () => {
    expect(reviewDiffLanguage("src/a.TS")).toBe("typescript");
    expect(reviewDiffLanguage("x/y.d.ts")).toBe("typescript");
    expect(reviewDiffLanguage("Main.kt")).toBe("kotlin");
    expect(reviewDiffLanguage(".bashrc")).toBe("other");
    expect(reviewDiffLanguage("Makefile")).toBe("other");
    expect(reviewDiffLanguage("dir.ts/file")).toBe("other");
  });
});
