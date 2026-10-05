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
 */
import { FormBuilder } from "@ginkgo-bioworks/react-json-schema-form-builder";
import { createTheme, ThemeProvider } from "@mui/material/styles";
import { withTheme } from "@rjsf/core";
import { Theme as MuiTheme } from "@rjsf/mui";
import type { RJSFSchema, UiSchema } from "@rjsf/utils";
import validator from "@rjsf/validator-ajv8";
import { t } from "@/lib/i18n";
import type { KnowledgeChecklist } from "@/lib/knowledge";

const PreviewForm = withTheme(MuiTheme);

/*
 * A fixed light theme: the builder and the preview are an authoring island
 * inside a page that draws itself with the app's own CSS variables, so this
 * island carries its own theme and never leaks one into the app.
 */
const theme = createTheme({ palette: { mode: "light" } });

export default function ChecklistSurface({
  checklist,
  editable,
  onChange,
}: {
  checklist: KnowledgeChecklist;
  editable: boolean;
  onChange?: (checklist: KnowledgeChecklist) => void;
}) {
  const schema = checklist.schema as unknown as RJSFSchema;
  const uiSchema = checklist.uiSchema as unknown as UiSchema;
  return (
    <ThemeProvider theme={theme}>
      {editable && onChange && (
        <FormBuilder
          schema={JSON.stringify(checklist.schema)}
          uischema={JSON.stringify(checklist.uiSchema)}
          onChange={(nextSchema, nextUiSchema) =>
            onChange({
              schema: JSON.parse(nextSchema) as Record<string, unknown>,
              uiSchema: JSON.parse(nextUiSchema) as Record<string, unknown>,
            })
          }
        />
      )}
      <section style={{ marginTop: 24 }}>
        <h3 style={{ margin: "0 0 8px" }}>{t("Preview")}</h3>
        <PreviewForm
          schema={schema}
          uiSchema={uiSchema}
          validator={validator}
          disabled={!editable}
        />
      </section>
    </ThemeProvider>
  );
}
