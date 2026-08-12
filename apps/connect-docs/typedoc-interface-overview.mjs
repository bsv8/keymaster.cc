import { ReflectionKind } from "typedoc";
import { MarkdownTheme, MarkdownThemeContext } from "typedoc-plugin-markdown";

function tableCell(value) {
  return value
    .trim()
    .replace(/\r?\n+/g, " ")
    .replace(/(?<!\\)\|/g, "\\|");
}

function firstSentence(value) {
  const normalized = value.trim().replace(/\r?\n+/g, " ");
  return normalized.match(/^.*?(?:[。！？]|[.!?](?=\s|$))/)?.[0] ?? normalized;
}

class ConnectDocsThemeContext extends MarkdownThemeContext {
  constructor(theme, page, options) {
    super(theme, page, options);

    const renderMemberWithGroups = this.partials.memberWithGroups;
    this.partials.memberWithGroups = (model, renderOptions) => {
      const properties = model.kind === ReflectionKind.Interface
        ? model.children?.filter((child) => child.kind === ReflectionKind.Property) ?? []
        : [];
      if (!properties.length) return renderMemberWithGroups(model, renderOptions);

      const introduction = model.comment
        ? this.partials.comment(model.comment, { headingLevel: renderOptions.headingLevel })
        : "";
      const overview = this.renderPropertiesOverview(properties);
      const comment = model.comment;

      try {
        model.comment = undefined;
        return [introduction, overview, renderMemberWithGroups(model, renderOptions)]
          .filter(Boolean)
          .join("\n\n");
      } finally {
        model.comment = comment;
      }
    };
  }

  renderPropertiesOverview(properties) {
    const rows = properties.map((property) => {
      const propertyType = this.helpers.getDeclarationType(property);
      const renderedType = propertyType ? this.partials.someType(propertyType) : "unknown";
      const renderedName = `\`${property.name}${property.flags.isOptional ? "?" : ""}\``;
      const propertyUrl = this.urlTo(property);
      const linkedName = propertyUrl ? `[${renderedName}](${propertyUrl})` : renderedName;
      const description = property.comment?.summary?.length
        ? firstSentence(this.helpers.getCommentParts(property.comment.summary))
        : "—";

      return `| ${tableCell(linkedName)} | ${tableCell(renderedType)} | ${property.flags.isOptional ? "No" : "Yes"} | ${tableCell(description)} |`;
    });

    return [
      "## Properties overview",
      "",
      "| Property | Type | Required | Description |",
      "| :--- | :--- | :---: | :--- |",
      ...rows
    ].join("\n");
  }
}

class ConnectDocsTheme extends MarkdownTheme {
  getRenderContext(page) {
    return new ConnectDocsThemeContext(this, page, this.application.options);
  }
}

export function load(app) {
  app.renderer.defineTheme("connect-docs", ConnectDocsTheme);
}
