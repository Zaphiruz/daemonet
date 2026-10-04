/** `[TAG] name` for an operator in an org, else just the name. Always plain text: never put the result in markup. */
export function taggedName(tag: string | null | undefined, name: string | null | undefined, fallback = '?'): string {
  return `${tag ? `[${tag}] ` : ''}${name ?? fallback}`;
}
