import { exec } from "node:child_process";

export class LocalExecutor {
  async executeCommand(command: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      exec(command, { timeout: 60_000 }, (error, stdout, stderr) => {
        if (error) {
          const errorOutput = [stderr.trim(), stdout.trim(), error.message].filter(Boolean).join("\n");
          reject(new Error(errorOutput));
          return;
        }

        const output = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
        resolve(output || "(empty output)");
      });
    });
  }
}
