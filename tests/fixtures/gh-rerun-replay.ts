import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const createRerunGh = async (root: string, interpreter: string, outcome: string) => {
  const bin = join(root, "bin");
  await mkdir(bin);
  const path = join(bin, "gh");
  const state = join(root, "rerun-started");
  await writeFile(
    path,
    `#!${interpreter}
const fs = require("node:fs");
const args = process.argv.slice(2);
const state = ${JSON.stringify(state)};
const outcome = ${JSON.stringify(outcome)};
const print = (value) => console.log(JSON.stringify(value));
if(args[0] === "repo") print({owner:{login:"owner"},name:"repo",defaultBranchRef:{name:"main"},url:"https://github.com/owner/repo"});
else if(args[0] === "pr" && args[1] === "checks") print([{name:"build",state:"FAILURE",bucket:"fail",link:"https://github.com/owner/repo/actions/runs/100"}]);
else if(args[0] === "run" && args[1] === "rerun") fs.writeFileSync(state,"yes");
else if(args[0] === "run" && args[1] === "view") {
  const rerun = fs.existsSync(state);
  const pending = rerun && outcome === "pending";
  print({databaseId:100,attempt:rerun?2:1,status:pending?"in_progress":"completed",conclusion:pending?null:rerun?outcome:"failure",jobs:[]});
} else {console.error("Unsupported synthetic rerun command");process.exitCode=98;}
`,
  );
  await chmod(path, 0o755);
  return bin;
};
