import { describe, expect, test } from 'vitest';

import { extractLeadingMarkers, parseMarkdownFile, toModuleWindowData } from '../src/shared/markdown';

describe('extractLeadingMarkers', () => {
  test('extracts one leading marker', () => {
    expect(extractLeadingMarkers('[进行中] Markdown 渲染')).toEqual({
      rawTitle: '[进行中] Markdown 渲染',
      title: 'Markdown 渲染',
      markers: ['进行中'],
    });
  });

  test('extracts consecutive leading markers and trims whitespace', () => {
    expect(extractLeadingMarkers('  [进行中] [P1]  Markdown 渲染  ')).toMatchObject({
      title: 'Markdown 渲染',
      markers: ['进行中', 'P1'],
    });
  });

  test('ignores empty markers', () => {
    expect(extractLeadingMarkers('[] [  ] [P1] 标题')).toMatchObject({
      title: '标题',
      markers: ['P1'],
    });
  });

  test('does not treat trailing brackets as markers', () => {
    expect(extractLeadingMarkers('支持数组 [Array]')).toMatchObject({
      title: '支持数组 [Array]',
      markers: [],
    });
  });

  test('allows marker-only headings with fallback title', () => {
    expect(extractLeadingMarkers('[完成]')).toMatchObject({
      title: '未命名标题',
      markers: ['完成'],
    });
  });
});

describe('parseMarkdownFile', () => {
  test('creates one document module when there is no h1', () => {
    const parsed = parseMarkdownFile('intro\n\n## [进行中] 概要\n正文', 'docs/work.md', 1);

    expect(parsed.modules).toHaveLength(1);
    expect(parsed.modules[0].title).toBe('work.md');
    expect(parsed.modules[0].source.kind).toBe('document');
    expect(parsed.modules[0].headings[0]).toMatchObject({
      depth: 2,
      rawTitle: '[进行中] 概要',
      title: '概要',
      markers: ['进行中'],
    });
  });

  test('creates a document module for preface and an h1 module when there is one h1', () => {
    const parsed = parseMarkdownFile('preface\n\n# [P1] 当前进度\n\n开场\n\n## 任务', 'plan.md', 1);

    expect(parsed.modules).toHaveLength(2);
    expect(parsed.modules[0].title).toBe('plan.md');
    expect(parsed.modules[0].source.kind).toBe('document');
    expect(parsed.modules[0].leadingBody).toHaveLength(1);
    expect(parsed.modules[1].title).toBe('当前进度');
    expect(parsed.modules[1].source.kind).toBe('h1');
    expect(parsed.modules[1].headings[0].title).toBe('任务');
  });

  test('places h2-h6 before first h1 into document module heading tree', () => {
    const parsed = parseMarkdownFile('## A\n\n### B\n\n# H1', 'plan.md', 1);

    expect(parsed.modules).toHaveLength(2);
    expect(parsed.modules[0].moduleKey).toBe('plan.md::document::0');
    expect(parsed.modules[0].headings).toHaveLength(1);
    expect(parsed.modules[0].headings[0].title).toBe('A');
    expect(parsed.modules[0].headings[0].children[0].title).toBe('B');
    expect(parsed.modules[1].moduleKey).toBe('plan.md::H1::0');
  });

  test('preface with only whitespace does not create a document module', () => {
    const parsed = parseMarkdownFile('\n\n\n# H1', 'plan.md', 1);

    expect(parsed.modules).toHaveLength(1);
    expect(parsed.modules[0].moduleKey).toBe('plan.md::H1::0');
  });

  test('no h1 file creates single document module', () => {
    const parsed = parseMarkdownFile('intro\n\n## [进行中] 概要\n正文', 'docs/work.md', 1);

    expect(parsed.modules).toHaveLength(1);
    expect(parsed.modules[0].title).toBe('work.md');
    expect(parsed.modules[0].source.kind).toBe('document');
  });

  test('document module with multiple h1 has preface and first h1 before second', () => {
    const parsed = parseMarkdownFile('preface\n\n# A\n\n## AA\n\n# B', 'plan.md', 1);

    expect(parsed.modules).toHaveLength(3);
    expect(parsed.modules[0].moduleKey).toBe('plan.md::document::0');
    expect(parsed.modules[1].moduleKey).toBe('plan.md::A::0');
    expect(parsed.modules[2].moduleKey).toBe('plan.md::B::0');
  });

  test('splits multiple h1 headings into modules', () => {
    const parsed = parseMarkdownFile('# 当前进度\n\n## A\n\n# 问题\n\n## B', 'plan.md', 1);

    expect(parsed.modules.map((module) => module.title)).toEqual(['当前进度', '问题']);
    expect(parsed.modules[0].headings[0].title).toBe('A');
    expect(parsed.modules[1].headings[0].title).toBe('B');
  });

  test('tracks duplicate h1 modules by occurrence', () => {
    const parsed = parseMarkdownFile('# 问题\n\n## A\n\n# 问题\n\n## B', 'plan.md', 1);

    expect(parsed.modules.map((module) => module.moduleKey)).toEqual([
      'plan.md::问题::0',
      'plan.md::问题::1',
    ]);
  });

  test('builds nested h2-h6 heading tree', () => {
    const parsed = parseMarkdownFile('# M\n\n## A\n\n### B\n\n#### C\n\n###### D', 'plan.md', 1);
    const root = parsed.modules[0].headings[0];

    expect(root.title).toBe('A');
    expect(root.children[0].title).toBe('B');
    expect(root.children[0].children[0].title).toBe('C');
    expect(root.children[0].children[0].children[0].title).toBe('D');
  });

  test('does not identify body brackets as markers', () => {
    const parsed = parseMarkdownFile('# M\n\n正文 [进行中]\n\n## 标题', 'plan.md', 1);

    expect(parsed.markers).toEqual([]);
  });

  test('does not identify code block headings', () => {
    const parsed = parseMarkdownFile('# M\n\n```md\n# 不是模块\n## [P1] 不是标题\n```\n\n## 真标题', 'plan.md', 1);

    expect(parsed.modules).toHaveLength(1);
    expect(parsed.modules[0].headings).toHaveLength(1);
    expect(parsed.modules[0].headings[0].title).toBe('真标题');
    expect(parsed.markers).toEqual([]);
  });

  test('keeps table, list, task list, and code block in heading body', () => {
    const markdown = [
      '# M',
      '## Section',
      '- item',
      '- [ ] task',
      '',
      '| A | B |',
      '| - | - |',
      '| 1 | 2 |',
      '',
      '```ts',
      'const value = 1;',
      '```',
    ].join('\n');
    const parsed = parseMarkdownFile(markdown, 'plan.md', 1);
    const bodyTypes = parsed.modules[0].headings[0].body.map((node) => node.type);

    expect(bodyTypes).toEqual(['list', 'table', 'code']);
  });

  test('creates stable duplicate sibling heading keys', () => {
    const parsed = parseMarkdownFile('# M\n\n## A\n\n### B\n\n### B\n\n## A', 'plan.md', 1);

    expect(parsed.modules[0].headings.map((heading) => heading.headingKey)).toEqual(['A', 'A#1']);
    expect(parsed.modules[0].headings[0].children.map((heading) => heading.headingKey)).toEqual(['B', 'B#1']);
  });

  test('builds module window data without repeating the module h1', () => {
    const parsed = parseMarkdownFile(
      [
        '# Current',
        '',
        'Intro body',
        '',
        '## [P1] Work',
        '',
        '- [ ] task',
        '',
        '| A | B |',
        '| - | - |',
        '| 1 | 2 |',
        '',
        '### Work',
        '',
        '```ts',
        'const value = 1;',
        '```',
      ].join('\n'),
      'CURRENT.md',
      1,
    );
    const data = toModuleWindowData('CURRENT.md', parsed.modules[0]);

    expect(data.title).toBe('Current');
    expect(data.leadingBodyMarkdown).toContain('Intro body');
    expect(data.headings.map((heading) => heading.title)).toEqual(['Work']);
    expect(data.headings[0].markers).toEqual(['P1']);
    expect(data.headings[0].bodyMarkdown).toContain('[ ] task');
    expect(data.headings[0].bodyMarkdown).toContain('| A | B |');
    expect(data.headings[0].children[0].viewKey).toBe('Work/Work');
  });
});
