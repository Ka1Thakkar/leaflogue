import { forwardRef, Fragment, type MouseEvent } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

function openLink(event: MouseEvent<HTMLAnchorElement>, href: string) {
  // The renderer never navigates. The main process confirms with the reader
  // and opens only credential-free https links in their browser.
  event.preventDefault();
  void window.leaflogue.system.openExternal(href).catch(() => undefined);
}

const components: Components = {
  a({ href, children }) {
    if (!href || !/^https:\/\//iu.test(href)) return <span>{children}</span>;
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" onClick={(event) => openLink(event, href)} title={href}>
        {children}
        <span className="sr-only"> (opens in your browser after confirmation)</span>
      </a>
    );
  },
  // Remote images stay blocked by the content policy, so show their words.
  img({ alt }) {
    return alt ? <span>{alt}</span> : null;
  },
};

/** Reader-written Markdown with raw HTML dropped and links kept inside the app. */
export const MarkdownText = forwardRef<HTMLDivElement, { readonly text: string; readonly className?: string; readonly id?: string }>(
  function MarkdownText({ text, className, id }, ref) {
    return (
      <div ref={ref} id={id} className={className}>
        <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={defaultUrlTransform} components={components}>
          {text}
        </ReactMarkdown>
      </div>
    );
  },
);

/** Words from a book, shown as written: paragraphs and line breaks kept, nothing read as Markdown. */
export const PlainText = forwardRef<HTMLDivElement, { readonly text: string; readonly className?: string; readonly id?: string }>(
  function PlainText({ text, className, id }, ref) {
    const paragraphs = text.split(/\n\s*\n/u).map((paragraph) => paragraph.trim()).filter(Boolean);
    return (
      <div ref={ref} id={id} className={className}>
        {paragraphs.map((paragraph, index) => (
          <p key={index}>
            {paragraph.split(/\s*\n\s*/u).map((line, lineIndex) => (
              <Fragment key={lineIndex}>{lineIndex > 0 && <br />}{line}</Fragment>
            ))}
          </p>
        ))}
      </div>
    );
  },
);
