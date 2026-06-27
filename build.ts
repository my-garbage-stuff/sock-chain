// Build script: compiles the binary for Linux and Windows (GUI subsystem).

import { readFile, writeFile } from "fs/promises";

const GUI_SUBSYSTEM = 0x2;
const CONSOLE_SUBSYSTEM = 0x3;

function panic(message: string): never {
  console.error(message);
  process.exit(1);
}

async function build(target: "bun-linux-x86_64" | "bun-windows-x64") {
  const result = await Bun.build({
    compile: true,
    target,
    minify: true,
    entrypoints: ["src/index.ts"],
    outdir: "dist",
  });
  if (!result.success) panic("Build failed.");
  if (target === "bun-windows-x64") {
    const exePath = result.outputs
      .map(o => o.path)
      .find(p => p.endsWith(".exe"));
    if (!exePath) panic("No EXE file found in build outputs.");
    await setWindowsSubsystem(exePath);
  }
}

async function setWindowsSubsystem(filePath: string) {
  const data = await readFile(filePath);
  const buffer = Buffer.from(data);
  const peOffset = buffer.readUInt32LE(0x3C);
  const subsystemOffset = peOffset + 0x5C;
  const current = buffer.readUInt16LE(subsystemOffset);
  if (current !== CONSOLE_SUBSYSTEM) {
    panic(`Unexpected subsystem value: 0x${current.toString(16)}`);
  }
  buffer.writeUInt16LE(GUI_SUBSYSTEM, subsystemOffset);
  await writeFile(filePath, buffer);
}

await build("bun-windows-x64");
await build("bun-linux-x86_64");
