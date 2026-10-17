import ssh2 from "ssh2";
import * as fs from "node:fs/promises";
import path from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { once } from "node:events";

const { Server, utils } = ssh2;
const { STATUS_CODE, flagsToString } = utils.sftp;
const hostKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" });
const attrs = (stat) => ({
  mode: stat.mode, uid: stat.uid, gid: stat.gid, size: stat.size,
  atime: Math.floor(stat.atimeMs / 1000), mtime: Math.floor(stat.mtimeMs / 1000),
});

export async function startSftpServer(t, root, { denyDelete = false } = {}) {
  const clients = new Set();
  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    clients.add(client);
    client.on("close", () => clients.delete(client));
    client.on("error", () => {});
    client.on("authentication", (context) => {
      if (context.method === "password" && context.username === "test" && context.password === "test-only") context.accept();
      else context.reject();
    });
    client.on("ready", () => client.on("session", (accept) => {
      accept().on("sftp", (acceptSftp) => {
        const sftp = acceptSftp();
        const handles = new Map();
        let nextHandle = 0;
        const local = (remote) => {
          const relative = path.posix.normalize(remote).replace(/^\/+/, "");
          const full = path.resolve(root, relative);
          if (full !== root && !full.startsWith(`${root}${path.sep}`)) throw new Error("Path escape");
          return full;
        };
        const handle = (value) => {
          const id = ++nextHandle;
          handles.set(id, value);
          const buffer = Buffer.alloc(4);
          buffer.writeUInt32BE(id);
          return buffer;
        };
        const get = (buffer) => handles.get(buffer.readUInt32BE());
        const on = (event, callback) => sftp.on(event, (id, ...args) => {
          Promise.resolve().then(() => callback(id, ...args)).catch((error) => {
            const code = error.code === "ENOENT" ? STATUS_CODE.NO_SUCH_FILE :
              error.code === "EACCES" ? STATUS_CODE.PERMISSION_DENIED : STATUS_CODE.FAILURE;
            sftp.status(id, code, error.message);
          });
        });
        on("REALPATH", async (id, remote) => sftp.name(id, [{ filename: path.posix.resolve("/", remote), longname: "", attrs: {} }]));
        for (const event of ["STAT", "LSTAT"]) {
          on(event, async (id, remote) => sftp.attrs(id, attrs(await fs.lstat(local(remote)))));
        }
        on("FSTAT", async (id, buffer) => sftp.attrs(id, attrs(await get(buffer).stat())));
        on("FSETSTAT", async (id, buffer, attributes) => {
          if (attributes.mode !== undefined) await get(buffer).chmod(attributes.mode);
          sftp.status(id, STATUS_CODE.OK);
        });
        on("SETSTAT", async (id, remote, attributes) => {
          if (attributes.mode !== undefined) await fs.chmod(local(remote), attributes.mode);
          sftp.status(id, STATUS_CODE.OK);
        });
        on("OPEN", async (id, remote, flags) => {
          sftp.handle(id, handle(await fs.open(local(remote), flagsToString(flags))));
        });
        on("READ", async (id, buffer, offset, length) => {
          const data = Buffer.alloc(length);
          const { bytesRead } = await get(buffer).read(data, 0, length, offset);
          if (!bytesRead) sftp.status(id, STATUS_CODE.EOF);
          else sftp.data(id, data.subarray(0, bytesRead));
        });
        on("WRITE", async (id, buffer, offset, data) => {
          await get(buffer).write(data, 0, data.length, offset);
          sftp.status(id, STATUS_CODE.OK);
        });
        on("CLOSE", async (id, buffer) => {
          const value = get(buffer);
          if (value.close) await value.close();
          handles.delete(buffer.readUInt32BE());
          sftp.status(id, STATUS_CODE.OK);
        });
        on("OPENDIR", async (id, remote) => {
          const directory = local(remote);
          const children = await fs.readdir(directory);
          const entries = await Promise.all(children.map(async (name) => {
            const stat = await fs.lstat(path.join(directory, name));
            return { filename: name, longname: `${stat.isDirectory() ? "d" : "-"}rwxr-xr-x 1 test test ${stat.size} Jan 1 00:00 ${name}`, attrs: attrs(stat) };
          }));
          sftp.handle(id, handle({ entries, read: false }));
        });
        on("READDIR", async (id, buffer) => {
          const directory = get(buffer);
          if (directory.read || !directory.entries.length) sftp.status(id, STATUS_CODE.EOF);
          else { directory.read = true; sftp.name(id, directory.entries); }
        });
        on("MKDIR", async (id, remote) => { await fs.mkdir(local(remote)); sftp.status(id, STATUS_CODE.OK); });
        on("REMOVE", async (id, remote) => {
          if (denyDelete) { sftp.status(id, STATUS_CODE.PERMISSION_DENIED); return; }
          await fs.unlink(local(remote));
          sftp.status(id, STATUS_CODE.OK);
        });
        on("RMDIR", async (id, remote) => { await fs.rmdir(local(remote)); sftp.status(id, STATUS_CODE.OK); });
        on("RENAME", async (id, from, to) => { await fs.rename(local(from), local(to)); sftp.status(id, STATUS_CODE.OK); });
        sftp.on("end", () => {
          for (const value of handles.values()) {
            if (value.close) void value.close();
          }
          handles.clear();
        });
      });
    }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    for (const client of clients) client.end();
    await new Promise((resolve) => server.close(resolve));
  });
  return server.address().port;
}
