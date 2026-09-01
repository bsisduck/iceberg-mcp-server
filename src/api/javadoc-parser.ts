import * as cheerio from 'cheerio';
import { z } from 'zod';

import type {
  MemberDocumentation,
  MemberRecord,
  PackageRecord,
  TypeDocumentation,
  TypeRecord,
} from './types.js';
import { UpstreamError } from '../shared/errors.js';

const packageNameSchema = z.string().regex(/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/u);
const typeNameSchema = z.string().regex(/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/u);
const packageIndexRecordSchema = z.strictObject({
  l: z.string().min(1).max(500),
  u: z.string().optional(),
});
const typeIndexRecordSchema = z.strictObject({
  l: z.string().min(1).max(500),
  p: packageNameSchema.optional(),
  u: z.string().max(1_000).optional(),
});
const memberIndexRecordSchema = z.strictObject({
  c: z.string().max(500),
  l: z.string().min(1).max(2_000),
  p: z.string().max(500),
  u: z.string().max(4_000).optional(),
});

function normalizeText(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

function parseAssignment(text: string, variable: string): unknown[] {
  const prefix = `${variable} = `;
  const suffix = ';updateSearchResults();';
  if (!text.startsWith(prefix) || !text.endsWith(suffix)) {
    throw new UpstreamError(`Invalid ${variable} wrapper`, 502, false);
  }
  try {
    const parsed = JSON.parse(text.slice(prefix.length, -suffix.length)) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error('index payload is not an array');
    }
    return parsed;
  } catch (error) {
    throw new UpstreamError(`Invalid ${variable} payload`, 502, false, { cause: error });
  }
}

function typePath(packageName: string, label: string): string {
  return `${packageName.replaceAll('.', '/')}/${label}.html`;
}

function safeJavadocUrl(root: URL, relative: string): string {
  const parsed = new URL(relative, root);
  if (parsed.origin !== root.origin || !parsed.pathname.startsWith(root.pathname)) {
    throw new UpstreamError('Javadoc index URL escaped its version root', 502, false);
  }
  return parsed.href;
}

export function parsePackageIndex(text: string, root: URL): readonly PackageRecord[] {
  const packages: PackageRecord[] = [];
  for (const entry of parseAssignment(text, 'packageSearchIndex')) {
    const parsed = packageIndexRecordSchema.safeParse(entry);
    if (!parsed.success) {
      throw new UpstreamError('Invalid package index record', 502, false);
    }
    if (!packageNameSchema.safeParse(parsed.data.l).success) {
      continue;
    }
    packages.push({
      name: parsed.data.l,
      url: safeJavadocUrl(
        root,
        parsed.data.u ?? `${parsed.data.l.replaceAll('.', '/')}/package-summary.html`,
      ),
    });
  }
  return packages;
}

export function parseTypeIndex(text: string, root: URL): readonly TypeRecord[] {
  const results: TypeRecord[] = [];
  for (const entry of parseAssignment(text, 'typeSearchIndex')) {
    const parsed = typeIndexRecordSchema.safeParse(entry);
    if (!parsed.success) {
      throw new UpstreamError('Invalid type index record', 502, false);
    }
    if (parsed.data.p === undefined) {
      continue;
    }
    if (!typeNameSchema.safeParse(parsed.data.l).success) {
      throw new UpstreamError('Invalid type index record', 502, false);
    }
    results.push({
      fullyQualifiedName: `${parsed.data.p}.${parsed.data.l}`,
      label: parsed.data.l,
      packageName: parsed.data.p,
      url: safeJavadocUrl(root, parsed.data.u ?? typePath(parsed.data.p, parsed.data.l)),
    });
  }
  return results;
}

export function parseMemberIndex(text: string, root: URL): readonly MemberRecord[] {
  const members: MemberRecord[] = [];
  for (const entry of parseAssignment(text, 'memberSearchIndex')) {
    const parsed = memberIndexRecordSchema.safeParse(entry);
    if (!parsed.success) {
      throw new UpstreamError('Invalid member index record', 502, false);
    }
    if (parsed.data.p === '' && parsed.data.c === '') {
      continue;
    }
    if (
      !packageNameSchema.safeParse(parsed.data.p).success ||
      !typeNameSchema.safeParse(parsed.data.c).success
    ) {
      throw new UpstreamError('Invalid member index record', 502, false);
    }
    const anchor = parsed.data.u ?? parsed.data.l;
    members.push({
      anchor,
      container: parsed.data.c,
      label: parsed.data.l,
      packageName: parsed.data.p,
      typeFullyQualifiedName: `${parsed.data.p}.${parsed.data.c}`,
      url: safeJavadocUrl(root, `${typePath(parsed.data.p, parsed.data.c)}#${anchor}`),
    });
  }
  return members;
}

export function parseTypeDocumentation(html: string): TypeDocumentation {
  const $ = cheerio.load(html);
  const title = normalizeText($('main h1.title').first().text() || $('h1.title').first().text());
  if (title === '') {
    throw new UpstreamError('Javadoc type page has no title', 502, false);
  }
  const declaration = normalizeText($('.type-signature').first().text()) || undefined;
  const description = normalizeText($('.class-description .block').first().text()) || undefined;
  const deprecated = normalizeText($('.deprecation-block').first().text()) || undefined;
  const members: MemberDocumentation[] = [];
  $('section.detail').each((_index, element) => {
    const section = $(element);
    const anchor = section.attr('id');
    const name = normalizeText(section.find('h3').first().text());
    if (anchor === undefined || name === '') {
      return;
    }
    members.push({
      anchor,
      declaration: normalizeText(section.find('.member-signature').first().text()) || undefined,
      description: normalizeText(section.find('.block').first().text()) || undefined,
      name,
    });
  });
  return { declaration, deprecated, description, members, title };
}
