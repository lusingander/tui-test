import path from "node:path";
import fsAsync from "node:fs/promises";
import fs from "node:fs";
import crypto from "node:crypto";
import readline from "node:readline";
import process from "node:process";
import swc from "@swc/core";

const cacheFolder = path.join(".tact", "cache");
const typescriptPattern = /^\.[mc]?ts[x]?$/;
const javascriptPattern = /^\.[mc]?js[x]?$/;

type SourceMap = {
  file?: string;
  sources?: string[];
};

const transformFile = async (source: string, sourceContent: string, sourceHash: string, destination: string) => {
  const fileExtension = path.extname(source);
  const fileType = typescriptPattern.test(fileExtension) ? "typescript" : javascriptPattern.test(fileExtension) ? "javascript" : undefined;
  if (fileType == null) {
    throw new Error("");
  }
  const result = await swc.transform(sourceContent, {
    filename: path.basename(source),
    swcrc: false,
    configFile: false,
    sourceMaps: true,
    module: {
      type: "es6",
    },
    jsc: {
      parser:
        fileType == "typescript"
          ? {
              syntax: "typescript",
              tsx: fileExtension == ".tsx",
            }
          : {
              syntax: "ecmascript",
              jsx: fileExtension == ".jsx",
            },
    },
  });

  const mapDestination = path.resolve(destination + ".map");
  const destinationFilename = path.basename(destination);
  const mapHeader = result.map != null ? `\n//# sourceMappingURL=${destinationFilename + ".map"}` : "";
  const hashHeader = `//# hash=${sourceHash}`;
  const code = `${hashHeader}${mapHeader}\n\n${result.code}`;

  await fsAsync.writeFile(destination, code);
  if (result.map != null) {
    const map = JSON.parse(result.map) as SourceMap;
    await fsAsync.writeFile(mapDestination, JSON.stringify({ ...map, file: destinationFilename, sources: [source] }));
  }
};

const copyFilesToCache = async (directory: string, destination: string) => {
  const directoryItems = await fsAsync.readdir(directory, {
    withFileTypes: true,
  });
  await Promise.all(
    directoryItems.map(async (directoryItem): Promise<void> => {
      if (directoryItem.isDirectory() && directoryItem.name.startsWith(".")) {
        return;
      }
      const resolvedPath = path.resolve(directory, directoryItem.name);
      const destinationPath = path.join(destination, directoryItem.name);
      if (directoryItem.isDirectory() && directoryItem.name == "node_modules") {
        return;
      } else if (directoryItem.isDirectory()) {
        if (!fs.existsSync(destinationPath)) {
          await fsAsync.mkdir(destinationPath);
        }
        await copyFilesToCache(resolvedPath, destinationPath);
      } else if (directoryItem.isFile() || directoryItem.isSymbolicLink()) {
        const fileExtension = path.extname(directoryItem.name);
        if (typescriptPattern.test(fileExtension) || javascriptPattern.test(fileExtension)) {
          const content = await fsAsync.readFile(resolvedPath);
          const fileHash = crypto.createHash("md5").update(content).digest("hex");
          const newExtension = fileExtension.startsWith(".m") ? ".mjs" : ".js";
          const transformedPath = path.join(destination, `${path.parse(directoryItem.name).name}${newExtension}`);
          if (fs.existsSync(transformedPath)) {
            const reader = readline.createInterface({
              input: fs.createReadStream(transformedPath),
              crlfDelay: Infinity,
            });
            const line = await new Promise<string>((resolve) => {
              reader.on("line", (line) => {
                reader.close();
                resolve(line);
              });
            });
            const existingHash = line.match(/\/\/#\s+hash=(.*)/)?.at(1);
            if (existingHash === fileHash) {
              return;
            }
          }
          await transformFile(resolvedPath, content.toString(), fileHash, transformedPath);
        } else {
          await fsAsync.copyFile(resolvedPath, destinationPath);
        }
      }
    })
  );
};

export const transformFiles = async () => {
  process.setSourceMapsEnabled(true);
  if (!fs.existsSync(cacheFolder)) {
    await fsAsync.mkdir(cacheFolder, { recursive: true });
  }
  await copyFilesToCache(process.cwd(), cacheFolder);
};
