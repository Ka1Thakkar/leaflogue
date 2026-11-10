import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const output = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { encoding: "utf8" },
);
const problems = [];

for (const path of output.split("\0").filter(Boolean)) {
  const content = readFileSync(path);
  if (content.includes(0)) continue;
  const text = content.toString("utf8");
  for (const [index, line] of text.split("\n").entries()) {
    if (/[ \t]$/.test(line)) problems.push(`${path}:${index + 1}: trailing whitespace`);
    if (/^(<<<<<<<|=======|>>>>>>>)(?: |$)/.test(line)) {
      problems.push(`${path}:${index + 1}: unresolved merge marker`);
    }
  }
}

if (problems.length > 0) {
  process.stderr.write(`${problems.join("\n")}\n`);
  process.exitCode = 1;
}
