const trimSlashes = (segment: string) => segment.replace(/^\/+|\/+$/g, "");

export const joinPath = (first: string, ...rest: readonly string[]) => {
  const isAbsolute = first.startsWith("/");
  const joined = [first, ...rest]
    .map(trimSlashes)
    .filter((segment) => segment !== "")
    .join("/");

  if (!isAbsolute) {
    return joined;
  }

  return joined === "" ? "/" : `/${joined}`;
};
