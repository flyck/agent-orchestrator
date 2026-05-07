import { describe, expect, test } from 'vitest';
import { renderMarkdown } from './markdown-view';

describe('renderMarkdown', () => {
  test('empty / nullish → empty string', () => {
    expect(renderMarkdown('')).toBe('');
    expect(renderMarkdown(null)).toBe('');
    expect(renderMarkdown(undefined)).toBe('');
  });

  test('plain paragraph wraps in <p>', () => {
    expect(renderMarkdown('hello').trim()).toBe('<p>hello</p>');
  });

  test('headings render as h-tags', () => {
    const out = renderMarkdown('# Title\n\nbody');
    expect(out).toContain('<h1>Title</h1>');
    expect(out).toContain('<p>body</p>');
  });

  test('inline code preserves the body', () => {
    const out = renderMarkdown('Run `git diff` to see.');
    expect(out).toContain('<code>git diff</code>');
  });

  test('fenced code block renders <pre><code>', () => {
    const out = renderMarkdown('```\nconsole.log(1)\n```');
    expect(out).toContain('<pre>');
    expect(out).toContain('console.log(1)');
  });

  test('lists render as <ul><li>', () => {
    const out = renderMarkdown('- one\n- two');
    expect(out).toContain('<ul>');
    expect(out).toContain('<li>one</li>');
    expect(out).toContain('<li>two</li>');
  });

  test('strips inline <script> via DOMPurify', () => {
    const out = renderMarkdown('Hi <script>alert(1)</script> there');
    expect(out).not.toContain('<script>');
    expect(out).not.toContain('alert(1)');
  });

  test('strips javascript: hrefs from links', () => {
    const out = renderMarkdown('[click](javascript:alert(1))');
    // DOMPurify either drops the href or empties it; either way no js:.
    expect(out).not.toContain('javascript:');
  });

  test('keeps safe https links intact', () => {
    const out = renderMarkdown('[docs](https://example.com)');
    expect(out).toContain('href="https://example.com"');
  });

  test('strips inline event handlers', () => {
    // marked may pass through inline HTML; DOMPurify strips on*.
    const out = renderMarkdown('<img src=x onerror=alert(1) />');
    expect(out).not.toContain('onerror');
  });

  test('tables render with headers and cells', () => {
    const out = renderMarkdown(
      '| Issue | Severity |\n|---|---|\n| A | high |\n| B | low |',
    );
    expect(out).toContain('<table');
    expect(out).toContain('<th');
    expect(out).toContain('<td');
    expect(out).toContain('A');
  });
});
