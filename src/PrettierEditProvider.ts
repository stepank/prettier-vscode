import {
  CancellationToken,
  DocumentFormattingEditProvider,
  DocumentRangeFormattingEditProvider,
  FormattingOptions,
  Range,
  TextDocument,
  TextEdit,
} from "vscode";

import { RangeFormattingOptions } from "./ConfigResolver";

export class PrettierEditProvider
  implements
    DocumentRangeFormattingEditProvider,
    DocumentFormattingEditProvider {
  constructor(
    private useLocalConfig: boolean,
    private provideEdits: (
      document: TextDocument,
      useLocalConfig: boolean,
      options?: RangeFormattingOptions
    ) => Promise<TextEdit[]>
  ) {}

  public async provideDocumentRangeFormattingEdits(
    document: TextDocument,
    range: Range,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    options: FormattingOptions,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    token: CancellationToken
  ): Promise<TextEdit[]> {
    return this.provideEdits(document, this.useLocalConfig, {
      rangeEnd: document.offsetAt(range.end),
      rangeStart: document.offsetAt(range.start),
    });
  }

  public async provideDocumentFormattingEdits(
    document: TextDocument,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    options: FormattingOptions,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    token: CancellationToken
  ): Promise<TextEdit[]> {
    return this.provideEdits(document, this.useLocalConfig);
  }
}
