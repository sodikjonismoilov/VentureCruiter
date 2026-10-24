import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import styles from './ChartImage.module.css';

// Model text may reference authenticated attachments, never remote tracking images.
export function isAttachmentImage(src: unknown): src is string {
  return typeof src === 'string' && /^\/api\/conversations\/[a-f0-9-]{36}\/attachments\/[a-f0-9-]{36}\/\d{1,4}$/i.test(src);
}

export function AttachmentImage({ src, alt }: React.ComponentProps<'img'>) {
  if (!isAttachmentImage(src)) return <span>{alt || 'Image'}</span>;
  return <span className={styles.chart}>
    <img className={styles.image} src={src} alt={alt || 'Chart attachment'} loading="lazy"/>
    <span className={styles.caption}><span>{alt || 'Chart'}</span><a href={src} target="_blank" rel="noopener noreferrer">Open full-size image</a><a href={src} download>Download image</a></span>
  </span>;
}

const plugins = [remarkGfm];
const components = {
  a: ({ children, href }: React.ComponentProps<'a'>) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
  img: AttachmentImage,
};

export default function MarkdownContent({ children }: { children: string }) {
  return <ReactMarkdown remarkPlugins={plugins} skipHtml components={components}>{children}</ReactMarkdown>;
}
