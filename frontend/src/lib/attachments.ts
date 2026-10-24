import type { Attachment } from './types';

const TASK_FILE_TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/plain', csv: 'text/plain', json: 'text/plain',
  wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg', flac: 'audio/flac',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
};

export async function readTaskAttachments(files: File[], existing: Attachment[] = []): Promise<Attachment[]> {
  if (existing.length + files.length > 4) throw new Error('Attach up to four files per task.');
  const existingBytes = existing.reduce((total, file) => total + file.data.length * 3 / 4 - (file.data.endsWith('==') ? 2 : file.data.endsWith('=') ? 1 : 0), 0);
  if (existingBytes + files.reduce((total, file) => total + file.size, 0) > 3 * 1024 * 1024) {
    throw new Error('Keep combined attachments below 3 MB.');
  }
  const accepted = new Set([...Object.values(TASK_FILE_TYPES), 'audio/webm']);
  const typed = files.map(file => {
    const mime = accepted.has(file.type) ? file.type : TASK_FILE_TYPES[file.name.split('.').pop()?.toLowerCase() || ''];
    if (!mime) throw new Error(`${file.name}: choose an image, PDF, text, audio, or video file.`);
    return { file, mime };
  });
  return Promise.all(typed.map(({ file, mime }) => readAttachment(file, mime)));
}

export function readAttachment(file: File, mime: string, timeoutMs = 15000): Promise<Attachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const fail = (message: string) => { clearTimeout(timer); reject(new Error(`${file.name}: ${message}`)); };
    const timer = setTimeout(() => { fail('File reading timed out. Select the file again.'); reader.abort(); }, timeoutMs);
    reader.onerror = () => fail('File could not be read. Select it again.');
    reader.onabort = () => fail('File reading was interrupted. Select it again.');
    reader.onload = () => {
      clearTimeout(timer);
      const data = typeof reader.result === 'string' ? reader.result.split(',')[1] : '';
      if (!data) { reject(new Error(`${file.name}: The file is empty or unreadable.`)); return; }
      resolve({ name: file.name, mime, data });
    };
    try { reader.readAsDataURL(file); } catch { fail('File could not be opened. Select it again.'); }
  });
}
