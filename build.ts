import { readFile, writeFile } from "fs/promises";

const GUI_SUBSYSTEM = 0x2;
const CONSOLE_SUBSYSTEM = 0x3;

async function buildLinuxExecutable() {
    const result = await Bun.build({
        compile: true,
        target: "bun-linux-x86_64",
        minify: true,
        entrypoints: ["src/index.ts"],
        outdir: "dist",
    });

    if (!result.success) panic("Build failed.");

}    

async function buildWindowsExecutable() {
    const result = await Bun.build({
        compile: true,
        target: "bun-windows-x64",
        entrypoints: ["src/index.ts"],
        minify: true,
        outdir: "dist",
    });

    if (!result.success) panic("Build failed.");

    const exePath = result.outputs
        .map(output => output.path)
        .find(path => path.endsWith(".exe"));

    if (!exePath) panic("No EXE file found in build outputs.");

    await setWindowsSubsystem(exePath);
}

async function setWindowsSubsystem(filePath: string) {
    const data = await readFile(filePath);
    const buffer = Buffer.from(data);

    const peOffset = buffer.readUInt32LE(0x3C);
    const subsystemOffset = peOffset + 0x5C;
    const currentSubsystem = buffer.readUInt16LE(subsystemOffset);

    if (currentSubsystem !== CONSOLE_SUBSYSTEM) panic(`Unexpected subsystem value: 0x${currentSubsystem.toString(16)}`);

    buffer.writeUInt16LE(GUI_SUBSYSTEM, subsystemOffset);

    await writeFile(filePath, buffer);
}

function panic(message: string): never {
    console.error(message);
    process.exit(1);
}

await buildWindowsExecutable();
await buildLinuxExecutable();
