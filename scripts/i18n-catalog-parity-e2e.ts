// Exercises the real catalog adapters with local text only. No app, account, or network starts.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createTranslate, en, TRANSLATED_LOCALES, translateFor } from "@openbot/i18n";
import { mobileTranslateFor } from "@openbot/i18n/mobile";
import { localizeSourceText, sourceText } from "@openbot/i18n/source";
import { appTranslation } from "../packages/i18n/src/app-catalogs";
import * as lazy from "../packages/i18n/src/lazy-catalogs";
import type { TranslatedLocale } from "../packages/i18n/src/locale";
import { mobileCatalog } from "../packages/i18n/src/mobile-catalogs";
import { mobileCatalog as nativeMobileCatalog } from "../packages/i18n/src/mobile-catalogs.native";
import { sourceTranslation } from "../packages/i18n/src/source-catalogs";
import { sourceTranslateFor } from "../packages/i18n/src/source-text";

const output = resolve(import.meta.dirname, "../.openbot-build/i18n-catalog-parity-e2e");
const locales = TRANSLATED_LOCALES.filter((locale) => locale !== "en");
const cases: string[] = [];
const report: { passed: boolean; locales: readonly string[]; cases: string[]; failure?: string } = {
  passed: false,
  locales,
  cases,
};

function appSamples(locale: TranslatedLocale): readonly string[] {
  const t = translateFor(locale);
  return [
    t("migrationPreparation.title"),
    t("migrationAssessment.title"),
    t("migrationAssessment.atLeastValue", { value: "fixture-42" }),
    t("migrationAssessment.count.exact", { count: 1 }),
    t("migrationAssessment.count.exact", { count: 2 }),
    t("migrationAssessment.count.at-least", { count: 1 }),
    t("migrationAssessment.count.at-least", { count: 2 }),
  ];
}

function sourceSamples(locale: TranslatedLocale): readonly string[] {
  const t = sourceTranslateFor(locale);
  return [
    t("error.hermesGateway.failed"),
    t("error.migration.preparationFailed"),
    t("error.migration.assessmentFailed"),
    t("status.hermesGateway.returnToApp"),
  ];
}

try {
  const englishApp = appSamples("en");
  assert.deepEqual(englishApp, [
    "Migration preparation",
    "Offline destination assessment",
    "At least fixture-42",
    "1 row",
    "2 rows",
    "At least 1 row",
    "At least 2 rows",
  ]);
  const englishSource = sourceSamples("en");
  const sourceWire = sourceText("error.hermesGateway.failed");
  assert.equal(sourceWire, "The Hermes gateway connection failed. Check the address and sign in again.");
  assert.equal(lazy.localeLoaded("en"), true);

  for (const locale of locales) {
    const catalog = appTranslation(locale);
    assert.ok(catalog);
    assert.deepEqual(appSamples(locale), englishApp, `${locale}: desktop fallback changed`);
    assert.deepEqual(sourceSamples(locale), englishSource, `${locale}: source fallback changed`);
    assert.equal(localizeSourceText(sourceWire, locale), sourceWire, `${locale}: wire text changed`);
    cases.push(`${locale}: desktop/source fallback, interpolation, and English singular/plural forms`);

    const mobile = mobileTranslateFor(locale);
    assert.deepEqual(
      [
        mobile("error.hermesGateway.failed"),
        mobile("error.migration.preparationFailed"),
        mobile("error.migration.assessmentFailed"),
        mobile("status.hermesGateway.returnToApp"),
      ],
      englishSource,
      `${locale}: mobile source fallback changed`,
    );
    assert.deepEqual(nativeMobileCatalog(locale), mobileCatalog(locale), `${locale}: native mobile catalog drift`);
    const existingCancel = catalog["common.cancel"];
    assert.equal(typeof existingCancel, "string");
    assert.notEqual(existingCancel, en["common.cancel"], `${locale}: existing translation fell back to English`);
    assert.equal(translateFor(locale)("common.cancel"), existingCancel);
    assert.equal(mobile("common.cancel"), existingCancel);
    cases.push(`${locale}: mobile/native catalogs and existing translated text`);

    assert.equal(lazy.localeLoaded(locale), false);
    assert.equal(lazy.appTranslation(locale), undefined);
    assert.equal(lazy.sourceTranslation(locale), undefined);
    const beforeLoad = createTranslate({
      source: en,
      translation: lazy.appTranslation(locale),
      locale,
      sourceLocale: "en",
    });
    assert.equal(beforeLoad("migrationAssessment.count.exact", { count: 1 }), "1 row");
    assert.equal(beforeLoad("common.cancel"), "Cancel");
    const loading = lazy.loadLocale(locale);
    assert.equal(lazy.loadLocale(locale), loading, `${locale}: concurrent locale loads did not share a request`);
    await loading;
    assert.equal(lazy.localeLoaded(locale), true);
    assert.deepEqual(lazy.appTranslation(locale), catalog, `${locale}: lazy app catalog drift`);
    assert.deepEqual(lazy.sourceTranslation(locale), sourceTranslation(locale), `${locale}: lazy source catalog drift`);
    const afterLoad = createTranslate({
      source: en,
      translation: lazy.appTranslation(locale),
      locale,
      sourceLocale: "en",
    });
    assert.equal(afterLoad("common.cancel"), existingCancel);
    assert.deepEqual(
      [
        afterLoad("migrationPreparation.title"),
        afterLoad("migrationAssessment.title"),
        afterLoad("migrationAssessment.atLeastValue", { value: "fixture-42" }),
        afterLoad("migrationAssessment.count.exact", { count: 1 }),
        afterLoad("migrationAssessment.count.exact", { count: 2 }),
        afterLoad("migrationAssessment.count.at-least", { count: 1 }),
        afterLoad("migrationAssessment.count.at-least", { count: 2 }),
      ],
      englishApp,
      `${locale}: loaded web fallback changed`,
    );
    cases.push(`${locale}: unloaded/loaded lazy catalogs, shared load, and fallback`);
  }
  report.passed = true;
} catch (error) {
  report.failure = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  await mkdir(output, { recursive: true });
  await writeFile(resolve(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${report.passed ? "passed" : "FAILED"}: ${cases.length} cases; ${output}/report.json\n`);
  if (report.failure) process.stderr.write(`${report.failure}\n`);
}
