const blocked = ((input: string | URL | Request) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  return Promise.reject(
    new Error(
      `Unit test attempted a real network request to ${url}. ` +
        `Route the call through GitHubService so the mock layer covers it, or stub globalThis.fetch in the test.`,
    ),
  );
}) as typeof globalThis.fetch;

globalThis.fetch = blocked;
