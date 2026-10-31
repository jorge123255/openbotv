import { TRANSLATED_LOCALES, type TranslatedLocale } from "@openbot/i18n";
import { installPointerFocusGuard } from "@openbot/ui/pointer-focus";
import type { Preview } from "storybook-solidjs-vite";
import { mount as mountSolidStory } from "storybook-solidjs-vite/renderer/solid-next";
import { StaticI18nProvider } from "../src/renderer/src/i18n-context";
import "../src/renderer/src/styles.css";
import "./preview.css";

installPointerFocusGuard();

function isTranslatedLocale(value: unknown): value is TranslatedLocale {
  return TRANSLATED_LOCALES.some((locale) => locale === value);
}

const preview: Preview = {
  // The Solid 2 renderer queues args and globals before it calls renderToCanvas.
  // Let that update commit before a story first reads or spreads its props.
  // Keep the framework's mount so controls, remounts and cleanup still use its store.
  mount: (context) => {
    const renderToCanvas = context.renderToCanvas;
    return mountSolidStory(
      Object.assign(context, {
        renderToCanvas: async () => {
          await Promise.resolve();
          await renderToCanvas();
        },
      }),
    );
  },
  // The toolbar switches every story's text, so a translation can be read in its real layout.
  globalTypes: {
    locale: {
      description: "Interface language",
      toolbar: { icon: "globe", items: [...TRANSLATED_LOCALES], dynamicTitle: true },
    },
    // The palette of tokens-light.css or the dark base, as the app's root attribute selects it.
    colorScheme: {
      description: "Color scheme",
      toolbar: { icon: "contrast", items: ["dark", "light"], dynamicTitle: true },
    },
  },
  initialGlobals: { locale: "en", colorScheme: "dark" },
  decorators: [
    (Story, context) => {
      document.documentElement.dataset.openbotColorScheme = context.globals.colorScheme === "light" ? "light" : "dark";
      return (
        <StaticI18nProvider locale={isTranslatedLocale(context.globals.locale) ? context.globals.locale : "en"}>
          <Story />
        </StaticI18nProvider>
      );
    },
  ],
  parameters: {
    layout: "fullscreen",
    a11y: {
      test: "error",
    },
    controls: {
      expanded: true,
    },
  },
};

export default preview;
