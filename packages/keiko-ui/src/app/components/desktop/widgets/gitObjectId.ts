export function gitObjectId(value: string | undefined): string | undefined {
  return value !== undefined && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value) ? value : undefined;
}
