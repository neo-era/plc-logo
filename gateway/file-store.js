'use strict';
/** Lưu bền trạng thái gateway: ghi nguyên tử (file tạm → fsync → rename). File hỏng → null (lõi tự về state ban đầu). */
const fs = require('node:fs');
const path = require('node:path');

function fileStore(file) {
  return {
    load() {
      try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
    },
    save(obj) {
      const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
      const fd = fs.openSync(tmp, 'w', 0o600);
      try { fs.writeSync(fd, JSON.stringify(obj)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(tmp, file);
      try { const d = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(d); } finally { fs.closeSync(d); } } catch { /* một số FS không hỗ trợ fsync thư mục */ }
    },
  };
}

module.exports = { fileStore };
