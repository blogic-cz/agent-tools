import { expect, it } from "vitest";
import packageMetadata from "../package.json";
import { identifierMatches } from "./guard-identifiers";
import { findPrivacyLeak } from "./guard-privacy";

const homePrefix = ["", "Users", ""].join("/");
const linuxHome = ["", "home", ""].join("/");
const organization = packageMetadata.name.split("/")[0]?.slice(1) ?? "";
it.each([
  homePrefix + "example-person/project",
  linuxHome + "example-person/project",
  ["", "project", "bp", "example"].join("/"),
  ["w", "99:p9"].join(""),
  ["w", "99:t9"].join(""),
])("finds planted personal structure %s", (text) =>
  expect(findPrivacyLeak("src/example.ts", text)).not.toBeNull(),
);
it.each(["/Users/dev/project", "/home/user/project", "w1:p1", "w2:t2"])(
  "accepts generic structure %s",
  (text) => expect(findPrivacyLeak("tests/example.test.ts", text)).toBeNull(),
);
it("refuses package identity in fixture data and accepts a package import", () => {
  const name = "@" + organization + "/agent-tools";
  expect(findPrivacyLeak("tests/fixtures/example.json", JSON.stringify({ name }))).toBe(
    "non-generic organization",
  );
  expect(findPrivacyLeak("src/example.test.ts", `const data = "${name}";`)).toBe(
    "non-generic organization",
  );
  expect(
    findPrivacyLeak("src/example.test.ts", `import { guard } from "${name}/guard";`),
  ).toBeNull();
  expect(findPrivacyLeak("README.md", `https://github.com/${organization}/agent-tools`)).toBeNull();
});

it("finds both name tokens without storing them as fixture text", () => {
  const parts = [
    [71, 97, 98, 114, 105, 101, 108],
    [69, 99, 101, 103, 105],
  ].map((points) => String.fromCharCode(...points));
  for (const token of parts) {
    expect(findPrivacyLeak("src/example.ts", token)).toBe("private identifier");
    expect(identifierMatches(token)).toHaveLength(1);
    expect(identifierMatches(token.toUpperCase())).toHaveLength(1);
  }
});
it("matches whole private tokens and permits ordinary public words", () => {
  const token = String.fromCharCode(110, 115, 117, 114, 101);
  expect(identifierMatches(token)).toHaveLength(1);
  expect(identifierMatches("ensure Ensure anthropic opus")).toEqual([]);
  expect(identifierMatches("a" + token + "z")).toEqual([]);
});
it("finds session identifiers in source and prose and permits generic values", () => {
  const session = "ses_" + "a".repeat(24);
  const uuid = ["12345678", "1234", "4234", "8234", "123456789abc"].join("-");
  for (const filename of ["src/example.ts", "README.md", "docs/example.json"]) {
    expect(findPrivacyLeak(filename, session)).toBe("private session identifier");
    expect(findPrivacyLeak(filename, uuid)).toBe("private session UUID");
    expect(findPrivacyLeak(filename, "example-session")).toBeNull();
    expect(findPrivacyLeak(filename, "00000000-0000-0000-0000-000000000000")).toBeNull();
  }
  expect(findPrivacyLeak("tests/example.test.ts", uuid)).toBeNull();
});
it("preserves required legal text and the skill lock", () => {
  const session = "ses_" + "a".repeat(24);
  expect(findPrivacyLeak("LICENSE", session)).toBeNull();
  expect(findPrivacyLeak("skills-lock.json", session)).toBeNull();
});

it("finds Windows homes with any escaped separator count", () => {
  for (const separator of ["/", "\\", "\\\\", "\\\\\\"])
    for (const filename of ["src/example.ts", "tests/example.test.ts"])
      for (const drive of ["C:", "z:"]) {
        const home = drive + separator + "Users" + separator;
        expect(findPrivacyLeak(filename, home + "plantedperson" + separator + "file.txt")).toBe(
          "personal home path",
        );
        for (const name of ["dev", "user", "test", "TEST", "x"])
          expect(findPrivacyLeak(filename, home + name + separator + "file.txt")).toBeNull();
      }
});
it("finds organization names inside mixed-case login words", () => {
  const stem = organization.split("-")[0] ?? organization;
  for (const value of [organization.toUpperCase(), "example" + stem.toUpperCase()])
    expect(findPrivacyLeak("tests/example.test.ts", value)).toBe("non-generic organization");
  const login = String.fromCharCode(77, 97, 114, 101, 107, 66, 108, 111, 103, 105, 99);
  expect(findPrivacyLeak("src/example.ts", login)).toBe("private identifier");
  expect(identifierMatches(login)).toHaveLength(1);
});

it("finds Unicode, driveless, UNC and encoded homes", () => {
  const names = ["plantedperson", "Žexample", "Šexample"];
  for (const name of names) {
    for (const text of [
      homePrefix + name + "/x",
      linuxHome + name + "/x",
      ["C:", "Users", name, "x"].join("\\"),
      ["", "Users", name, "x"].join("\\"),
      ["", "", "host", "c$", "Users", name].join("\\"),
      ["", "Users", name, "project"].join("-"),
    ])
      expect(findPrivacyLeak("tests/example.test.ts", text)).toBe("personal home path");
  }
  for (const name of ["dev", "user", "test", "x"])
    expect(
      findPrivacyLeak("tests/example.test.ts", ["", "Users", name, "project"].join("-")),
    ).toBeNull();
});
