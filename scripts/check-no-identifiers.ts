import { createHash } from "node:crypto";

const DEFAULT_FILES = [
  "tests/fixtures/credential-guard-corpus.json",
  "tests/credential-guard.test.ts",
  "src/credential-guard/index.ts",
];

type HashSpec = readonly [length: number, hash: string];

// Hashed denylist: concrete source identifiers stay out of the repository.
const HASHED_IDENTIFIERS: HashSpec[] = [
  [5, "f5cfcb570b7edac2ed16e1a025d50155d6148de7397f4068790cdfc142300070"],
  [5, "6a9776d2aecd05b06446574ec2c3ebd36ceb3fe5fa8470e5a1a4078391910472"],
  [9, "70849f557595d51bd1d1c04b109805e7d7ae72848c4648d00eb5fde84dbd0926"],
  [3, "ebecac3dbb3428c344df1b9e9656e0648db6b480513e8c763a69b5f0675465d3"],
  [6, "d0960501f8971be812f2e5494426e08cdbb2cbc3b3190ba60075f14b8da7178a"],
  [8, "3ebf6d6fc0124dd8a1f2ff876de35f02100acf2423ff3e3ee640ba0e52372c18"],
  [8, "8688afd0d744b1f7521d59e3300454d70ec9373f4109f3a35952457a7397ec08"],
  [8, "9d4b08a25e295aa671a766d96ba6921113dbf6d0d2c2f61555c7fc2561d90f3b"],
  [9, "b9a9b1e0675048421c30b82995df9d8fec2c0c2f7950ad1bca58828b0fb513fc"],
  [8, "58005676bb634d52f87d85b4eab9efb5f394279d4f93b926e94d84facca3542d"],
  [8, "8af6ad5d903ef40d130786e65cc5dded236bde505633ac7011f0ad61bd58631c"],
  [8, "6faeed037ee066f8fe3f18bf3f8e17159db1fc2869a3e0099977cd54b7fe6443"],
  [8, "b3c2dfea1cde58b804badbf029cccdbd3eb079b5272d1d66f58474982e42c769"],
  [6, "8e09865426b4d75207fd3a28c4c3b74c32c2a4f37d67a30dbdcd28f533a92f11"],
  [6, "6c3f5f727c1bc7081cb720db3bcb368203d21696e279e91e5793f2fc531c5cea"],
  [7, "700224c02633cea0b57a7e6147c3831e4e40eab517ccb711c2a93ed3c3186277"],
  [7, "79237f3c0424e12fc765054d4c8f5b0c833be027290c60c74618a327d7385eeb"],
  [6, "0036bd7819660300c2494c91d19d8ab94b29e1c67b2e7c05732b2496e6cdd2e1"],
  [6, "90710650f1daa6150125dcf85aada83779896f3dfadb9ce68ffd1f327d4622ac"],
  [4, "5e9765db01339eefb0997b4762c1f7e84000aaf88f480ab67c3a7e11dfecdbec"],
  [4, "f11fb7704eec905c6ec56f728e748d49ca9cdea9778674dcd8bda908680f918b"],
  [4, "1ea7eeed3768c1571aeaaf0f1c06e4b54596d3578c917ced968ed00b79e5d157"],
  [4, "3b2dcc427d1265c4deb5276c93527fba0d6c1b87c053f1ef547a12b461ef4873"],
  [9, "7e67b8916ceb8e311cd80df06e9ab812e28450fef33e34aa5de011dfebc3f3a5"],
  [9, "502ff256ca195809869c4e09bf90e28b64a5ab4cac7205f0d68b1084df67185e"],
  [9, "0195db57e27fd1c74e6f1e246b908f7cc04a88a916ffa87d131a4b8e3a787a23"],
  [23, "3d1e2c0faad6d027f2eec4ff008f225abbd93a92e5db26e83aae779ab706c4c6"],
  [6, "c857d09db23e6822e3600bc06ad8d58f92ed62bc8efd81c753f77048662cb97d"],
  [9, "c70eca6b0f88f44d81a41311647e50fda1ac454ec04ffd442b0eb4743a993131"],
  [4, "9ea35284f5f6208692f208e7bb9a1cf6c131ab43cca3fd55cfba9da6fb06ed6b"],
  [9, "b00ef262afae566b51f740124a6b12d982a2cff1bbf2ab5632cb548e98da6feb"],
  [3, "18c082269e98051b8aa3f8317f3ceced15ed820d5eb9715ee1e4db9df582759b"],
  [9, "f7ab38a516ebf5683723deb00faa532afbf85d09753701152af7373e6c1033d3"],
  [21, "4a5a962f0b1d60b263e1342fe2a08516a3e0da48f0996ec819e5a8bd50117f9b"],
  [14, "443b79f77a3bf85af1f32a31db4a0da575808c6841d736843c92027e613946b0"],
  [12, "da26c2baaa2410689da43e1c3fc436db51e59c0172b199fcaa396003125ebbb9"],
  [15, "9b81835623e376ead6fafe2a7ba1a52ed9135352965fb69a7acaf67a01f01135"],
  [13, "e516469fda546b871df113d5eb4cf6a2d89c82e3c27924b659409d3b24f83260"],
  [14, "42a18b6fe9b3b838daef6d6e8b8c05759cac1e7f2676e349cab81733f1fdc3a7"],
  [21, "e48de6440736ef0000495a1ab7a206d95e3ec3552aac2db2114194e79a2ecd60"],
  [21, "17f3dde852aec4e59c74a2abdbecb3dde3d3f9bd5dba741301e2c7b037c4fbac"],
  [25, "468ae51676d7c817e32321bdb888a35c9d43885570d3dd8b700945b355a63b22"],
  [53, "449e4a36063730ea1aed3855b6bca8a561da9dd417774280e4a249ae35057f8e"],
  [21, "9168d23615c70f6352e793d1e37bee3a0581620954f97b939f5779901d3c03c8"],
  [18, "92a98b3ccfe4e98e7abe34d89be59d21e91b762eef21df0d7aae4e88a913623d"],
  [8, "bc74d4c225d5b7d9149b370ab12c1f4aba41322dcb527d7ea1fa941028f176e8"],
  [16, "1b7afbe53f5e49af91b06e15ab2bc1dc907d834cf2e3c745e63b3c5e2c664113"],
  [7, "b2eb13c61b299154bbc8af7301698bc457b8e948d08543a9945c9315536ee5b8"],
  [10, "9a7e60cd1c7bb9d5493832103af02aca05272564b29e49852a9a0b5d8d96ec2c"],
  [5, "9c1431eeb94d267d98b1b11898232ef7095e72b4ea3b269ad458e5a317c81ae8"],
  [4, "970ec274ca867815174ebe4eff19282000f9495a6c7254e94991d1fb4dc3df30"],
  [4, "e12ce8285efc67c6d93d3a122e2589ed95089bcbb775ba5634d94e2b8385db07"],
  [11, "905d66aeddebdcf1f55c5d42ea7a9239c1eb2076f5dad9dcb371c0c4afe4962b"],
  [12, "dfabe2151a6a225ce47a1fc94fab274d1c9643ae5a9fe9e290740ee087205e2b"],
  [8, "625d13274aef386d7b7682def7c38ecf2811a0bfbe9ca6ddaf102d504095fe7f"],
  [6, "916efd2050c6941a1842734225487b8df750d89a5f7d24417e208828434544e0"],
  [7, "a2382db1c9121c9e5653c10c7c06b7b8c19dc3f32f5df6e1b484575aa06b8f07"],
  [6, "a7fceb54e0633431727913587615de4c34ece3c8b8b66e3ce48b3ab7f2e42b52"],
  [6, "8affa4b71173676b525735e53d289f09e8512b9b023bf98d2e92e5c44c67554d"],
  [16, "0b0dae3b785c8d7bb615b0617baa9a0a93722a80b988e40a40979da9e73064c3"],
  [14, "c6a1d57b0290a6d172dbebc32bf8baa1d8d8ce0dcd5ccd14d1ecd6a77efd22b7"],
  [6, "cfebe7802b7aef3b3e317124cd9134357bcfed0ffae70ba82db28a931d58ce46"],
  [5, "721b9664fcd594672eca2826c7fc07b26a3954cb1d37830ec7d033095f5b0458"],
  [6, "8a951f16375da0f22f6fbb598bca225d374da0d3a8d4cc3b9d7c38be6fb90dfa"],
  [6, "af6885db7d6cc9396eb8f0dd7e4c7131c7ae442fa5f9a0c194fb446b89e7bd9a"],
  [12, "ea5b5d121b98ccecba36438e5de6cadb2615c5e7a0ebb6e80df4252299d05e65"],
  [8, "d63f4a0cdaab52726d1ce895e4ac8c3507049e617b0a97d0a0af508bdad34a8d"],
  [14, "f2f9a6660f7443e0a4ec9d9f3fdb46613b58803c4effa79ad1691d243a5139d7"],
  [6, "d78138f2ae41d68afa1068f8919ede3ca327f041849639582aa72049c0cd9bb6"],
  [6, "70ad2419716a815599339fddb2af15a7376fbce43fcab51d1e2daa1c77bdf81a"],
  [5, "e148250506c5813b0c0c026a0748ecb3ba19ebe3a9c87b01fb727f65b455950b"],
  [5, "5f9038bb43cc490ea57459efe3e0fbfb89c2858613f35aabadb566859fbb1378"],
  [6, "adbb500ab58a95be65305bc3899427a3320caed5a0a6f7b328e326e28dbda5b7"],
  [6, "51dfe1514de34e554722e31f79dc5eed53f27909a6956e417605c564453a3f39"],
  [6, "5782141a6285da956104fa1d8544db802e58c9c49cc4703a874f55188f6e264e"],
  [6, "fc464ea5c69be8304094c4b40d428e8613652be5dac1cd45e322fef53eb1aad7"],
  [6, "1fda9997fd65ada4db9cff525eb04f3f8e5a5afe2ec1cbf7bf7a033f85c1c05a"],
  [6, "892201fdc4d5eab9361861ca7eb19fb752c29eb3138c3e502b7a7585656453f0"],
  [6, "cc14c07ca56edb86ce064a2609bb81eabd8720be25a6b28d12c14c8200672090"],
  [4, "48b29ad89e03083437a5d871413c896003c02131daf7660936ea053c5b99908a"],
  [4, "2e7047ec900d4d1f62461b65bcee6bfcce40ca27f04cfcbb2e3af0ca4a82f6f1"],
  [4, "58768668b59012cdc80bb42b987d2cf6c6353685372fa77bb61feb26f43b853c"],
  [4, "fd00bb0d6427ed75ff14945aeeecd1813a6358af9ff98cf6ff6302eeb4373f10"],
  [2, "d5ce3ebfc396d41d2d66fba13b2e1c038dcc6fdd1e7771271720cd9ca86c7e4f"],
  [4, "38459a491e7129b7429dd2cc34b2005188ecada9338665459d579d195ad7dd38"],
  [4, "8ec8ba5e706da86718e2f3846f79db3e7a52726d078397657427d2b326d8b256"],
  [4, "2dbad97c13a56edc10b2215ddc147d4757ebfc557ca1e15223f30e08abc2660a"],
  [4, "e5b4d4f51adaf87553378eef3297806c0ab71dbc425b8e9bea4178b5c6a2e792"],
  [4, "7ea23fea8bafeec356eea9324cba0b84a51e6b9fd323f57eb35bcfc928418323"],
  [4, "77ec7f71e2229e42422d8f442fc1c855303d195dd5b9090b37a7d0fa52aad8e6"],
  [4, "76b12907bd0016eeecef6101809a37d8268f7ddb7d6302ea6d56fab6722407d9"],
  [4, "acfb427a284ad75dc0db47dbbbc199753e961ad66ec47b7db209a2548c856f1d"],
];

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

function hasHashedIdentifier(text: string): boolean {
  const normalized = text.toLowerCase();
  const tokens = normalized.match(/[a-z0-9#_./-]+/g) ?? [];
  const candidates = new Set(tokens);
  for (const token of tokens) {
    for (const part of token.split(/[._/-]+/)) if (part) candidates.add(part);
  }
  return HASHED_IDENTIFIERS.some((spec) =>
    [...candidates].some(
      (candidate) => candidate.length === spec[0] && hash(candidate) === spec[1],
    ),
  );
}

function isDocumentationIp(value: string): boolean {
  const [a, b, c] = value.split(".").map(Number);
  return (
    (a === 192 && b === 0 && c === 2) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  );
}

function findGenericLeak(text: string): string | null {
  if (/\/Users\/(?!dev(?:\/|$))[^\s"'`/]+/.test(text)) return "personal home path";
  if (/[A-Z0-9._%+-]{2,}@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(text)) return "email address";
  if (/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i.test(text))
    return "uuid";
  if (/\b(?:gh[ps]_|github_pat_)[A-Za-z0-9_]{20,}/.test(text)) return "github token shape";
  if (/^\s*[A-Z][A-Z0-9_]{2,}=[^\s]+\s*$/m.test(text)) return "environment dump";
  const ticket = text.match(/\b[A-Z]{2,}-\d+\b/g)?.find((value) => !value.startsWith("PROJ-"));
  if (ticket) return "ticket key";
  const ipv4 = text
    .match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)
    ?.find((value) => !isDocumentationIp(value));
  if (ipv4) return "non-documentation IPv4 address";

  const allowedHosts = new Set([
    "api.github.com",
    "dev.azure.com",
    "discord.com",
    "discordapp.com",
    "downloads.example.com",
    "example.com",
    "github.com",
    "hooks.slack.com",
    "localhost",
  ]);
  for (const match of text.matchAll(/https?:\/\/([^/\s"'`]+)/gi)) {
    const host =
      (match[1] ?? "")
        .replace(/[\\'`]+$/g, "")
        .split(":")[0]
        ?.toLowerCase() ?? "";
    if (host !== "" && !allowedHosts.has(host) && !host.endsWith(".example.com")) {
      return "non-example domain";
    }
  }
  return null;
}

async function readInputs(): Promise<Array<{ name: string; text: string }>> {
  const args = Bun.argv.slice(2);
  if (args[0] === "--file" && args[1])
    return [{ name: args[1], text: await Bun.file(args[1]).text() }];
  if (args[0] === "--diff-range" && args[1]) {
    const proc = Bun.spawn(["git", "diff", "--no-ext-diff", args[1]], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const diff = await new Response(proc.stdout).text();
    if ((await proc.exited) !== 0) throw new Error("git diff failed");
    const text = diff
      .split("\n")
      .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
      .map((line) => line.slice(1))
      .join("\n");
    return [{ name: `git diff ${args[1]} additions`, text }];
  }
  return Promise.all(
    DEFAULT_FILES.map(async (file) => ({ name: file, text: await Bun.file(file).text() })),
  );
}

const leaks: string[] = [];
for (const input of await readInputs()) {
  const generic = findGenericLeak(input.text);
  if (generic) leaks.push(`${input.name}: ${generic}`);
  if (hasHashedIdentifier(input.text)) leaks.push(`${input.name}: hashed identifier denylist`);
}

if (leaks.length > 0) {
  console.error(leaks.join("\n"));
  process.exit(1);
}

console.log("identifier scan: 0 findings");
