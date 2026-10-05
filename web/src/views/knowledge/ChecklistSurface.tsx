/**
 * The checklist template surface (ADR 0030).
 *
 * A checklist template is not prose: the builder authors its **rules** — the
 * variants a workorder chooses, the boolean steps it checks and the dependencies
 * that branch a step off a variant value — and this renders them. Editing shows
 * the off-the-shelf form builder over the JSON Schema and uiSchema the page
 * stores; reading, and the live preview beside the builder, renders the same
 * definition through React JSON Schema Form, so a reader and the author see one
 * thing. It is a **lazy chunk**: the builder and its MUI theme are heavy and
 * belong to authoring, never to the app's first paint.
 *
 * The two panels are the app's own `.card`, and the builder's MUI island is
 * dressed in the app's CSS variables (`readCssVar`), so it looks like the page
 * it sits in rather than like MUI's defaults.
 */
import { FormBuilder } from "@ginkgo-bioworks/react-json-schema-form-builder";
import { createTheme, type Theme, ThemeProvider } from "@mui/material/styles";
import { withTheme } from "@rjsf/core";
import { Theme as MuiTheme } from "@rjsf/mui";
import type { RJSFSchema, UiSchema } from "@rjsf/utils";
import validator from "@rjsf/validator-ajv8";
import { useState } from "react";
import { readCssVar } from "@/lib/cssVars";
import { t } from "@/lib/i18n";
import type { KnowledgeChecklist } from "@/lib/knowledge";

const PreviewForm = withTheme(MuiTheme);

/**
 * The builder's MUI island, dressed in the app's own tokens.
 *
 * The builder and the schema renderer are MUI components, so their colours and
 * shapes are read from the app's CSS variables at mount rather than from MUI's
 * defaults: the island looks like the page it sits in. A few component overrides
 * flatten MUI's elevation and uppercase so nothing reads as a different product.
 */
function builderTheme(): Theme {
  return createTheme({
    palette: {
      mode: "light",
      primary: {
        main: readCssVar("--accent", "#0f766e"),
        contrastText: readCssVar("--accent-fg", "#ffffff"),
      },
      background: {
        default: readCssVar("--bg", "#f6f8fa"),
        paper: readCssVar("--bg-elev", "#ffffff"),
      },
      text: {
        primary: readCssVar("--fg", "#111827"),
        secondary: readCssVar("--fg-muted", "#5b6472"),
      },
      divider: readCssVar("--border", "#e3e7ec"),
    },
    shape: { borderRadius: 10 },
    typography: { fontFamily: readCssVar("--font-sans", "system-ui, sans-serif") },
    components: {
      MuiPaper: {
        defaultProps: { elevation: 0 },
        styleOverrides: { root: { backgroundImage: "none" } },
      },
      MuiCard: { defaultProps: { elevation: 0, variant: "outlined" } },
      MuiButton: {
        defaultProps: { disableElevation: true },
        styleOverrides: { root: { textTransform: "none", fontWeight: 600 } },
      },
      MuiIconButton: { styleOverrides: { root: { borderRadius: 8 } } },
      MuiOutlinedInput: { styleOverrides: { root: { borderRadius: 8 } } },
      MuiTooltip: { styleOverrides: { tooltip: { fontSize: 12, borderRadius: 6 } } },
      MuiDialog: { styleOverrides: { paper: { borderRadius: 14 } } },
    },
  });
}

export default function ChecklistSurface({
  checklist,
  editable,
  onChange,
}: {
  checklist: KnowledgeChecklist;
  editable: boolean;
  onChange?: (checklist: KnowledgeChecklist) => void;
}) {
  const [theme] = useState(builderTheme);
  const schema = checklist.schema as unknown as RJSFSchema;
  const uiSchema = checklist.uiSchema as unknown as UiSchema;
  return (
    <ThemeProvider theme={theme}>
      {editable && onChange && (
        <div className="card">
          <div className="card-head">
            <h3>{t("Checklist builder")}</h3>
          </div>
          {/* The mapping the builder itself does not state, kept to one line. */}
          <p className="hint">
            {t(
              "A step is a Checkbox, a variant a Select, and a condition is set in the element's pencil menu (Dependencies).",
            )}
          </p>
          <FormBuilder
            schema={JSON.stringify(checklist.schema)}
            uischema={JSON.stringify(checklist.uiSchema)}
            // The page title already names the template, so the builder's own
            // form-name head is noise here.
            mods={{ showFormHead: false }}
            onChange={(nextSchema, nextUiSchema) =>
              onChange({
                schema: JSON.parse(nextSchema) as Record<string, unknown>,
                uiSchema: JSON.parse(nextUiSchema) as Record<string, unknown>,
              })
            }
          />
        </div>
      )}
      <div className="card">
        <div className="card-head">
          <h3>{t("Preview")}</h3>
        </div>
        <p className="hint">
          {t("Try a variant value to see which steps apply. Nothing here is saved.")}
        </p>
        <PreviewForm
          schema={schema}
          uiSchema={uiSchema}
          validator={validator}
          disabled={!editable}
        />
      </div>
    </ThemeProvider>
  );
}
