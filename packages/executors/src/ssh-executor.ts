import { Client, type ConnectConfig } from "ssh2";

export type SSHConfig = ConnectConfig;

export class SSHExecutor {
  async executeCommand(config: SSHConfig, command: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const conn = new Client();
      let stdout = "";
      let stderr = "";

      conn
        .on("ready", () => {
          conn.exec(command, (execError, stream) => {
            if (execError) {
              conn.end();
              reject(execError);
              return;
            }

            stream
              .on("close", (code: number) => {
                conn.end();
                const output = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
                if (code !== 0) {
                  reject(new Error(output || `Command failed with exit code ${code}`));
                  return;
                }
                resolve(output || "(empty output)");
              })
              .on("data", (data: Buffer) => {
                stdout += data.toString();
              });

            stream.stderr.on("data", (data: Buffer) => {
              stderr += data.toString();
            });
          });
        })
        .on("error", (connectionError: Error) => {
          reject(connectionError);
        })
        .connect(config);
    });
  }
}
