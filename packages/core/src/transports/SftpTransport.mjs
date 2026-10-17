import path from "node:path";

export class SftpTransport {
  constructor({ client, uploadFile, onFileCount = () => {} }) {
    this.client = client;
    this.uploadFile = uploadFile;
    this.onFileCount = onFileCount;
  }

  async copy({ local, remotePath, rel }, kind) {
    await this.client.mkdir(path.posix.dirname(remotePath), true);
    await this.uploadFile(local.localPath, remotePath, rel, local.size);
    if (kind === "add") this.onFileCount(rel, 1);
  }

  async remove({ remotePath, rel }) {
    await this.client.delete(remotePath);
    this.onFileCount(rel, -1);
  }
}
