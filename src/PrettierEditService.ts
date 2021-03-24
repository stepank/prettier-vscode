import * as prettier from "prettier";
import {
  commands,
  Disposable,
  DocumentFilter,
  languages,
  Range,
  TextDocument,
  TextEdit,
  TextEditor,
  Uri,
  window,
  WindowState,
  workspace,
} from "vscode";
import { ConfigResolver, RangeFormattingOptions } from "./ConfigResolver";
import { IgnorerResolver } from "./IgnorerResolver";
import {
  getSupportedLanguages,
  getSupportedFileExtensions,
  getRangeSupportedLanguages,
  getParserFromLanguageId,
} from "./LanguageResolver";
import { LoggingService } from "./LoggingService";
import {
  INVALID_PRETTIER_CONFIG,
  RESTART_TO_ENABLE,
  UNABLE_TO_LOAD_PRETTIER,
} from "./message";
import { ModuleResolver } from "./ModuleResolver";
import { NotificationService } from "./NotificationService";
import { PrettierEditProvider } from "./PrettierEditProvider";
import { FormatterStatus, StatusBar } from "./StatusBar";
import { PrettierModule } from "./types";
import {
  getConfig,
  getWorkspaceRelativePath,
  isDefaultFormatterOrUnset,
} from "./util";
import * as cp from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

interface ISelectors {
  rangeLanguageSelector: ReadonlyArray<DocumentFilter>;
  languageSelector: ReadonlyArray<DocumentFilter>;
}

const USER_CONFIG_PATH = path.join(os.homedir(), ".prettierrc_user");

/**
 * Prettier reads configuration from files
 */
const PRETTIER_CONFIG_FILES = [
  ".prettierrc",
  ".prettierrc.json",
  ".prettierrc.json5",
  ".prettierrc.yaml",
  ".prettierrc.yml",
  ".prettierrc.toml",
  ".prettierrc.js",
  ".prettierrc.cjs",
  "package.json",
  "prettier.config.js",
  "prettier.config.cjs",
  ".editorconfig",
];

const execShell = (cmd: string) =>
  new Promise<string>((resolve, reject) => {
    cp.exec(cmd, (err, out) => {
      if (err) {
        return reject(err);
      }
      return resolve(out);
    });
  });

export default class PrettierEditService implements Disposable {
  private formatterHandler: undefined | Disposable;
  private rangeFormatterHandler: undefined | Disposable;
  private registeredWorkspaces = new Set<string>();
  private autoSaveAfterDelay = false;
  private userConfigAvailable = false;
  private useUserConfig = false;
  private userEditProvider?: PrettierEditProvider = undefined;
  private lastActiveTextEditor?: TextEditor = undefined;
  private visitedFiles: {
    [filePath: string]: { position: number; isDirty: boolean };
  } = {};

  constructor(
    private moduleResolver: ModuleResolver,
    private ignoreResolver: IgnorerResolver,
    private configResolver: ConfigResolver,
    private loggingService: LoggingService,
    private notificationService: NotificationService,
    private statusBar: StatusBar
  ) {}

  public registerDisposables(): Disposable[] {
    const packageWatcher = workspace.createFileSystemWatcher("**/package.json");
    packageWatcher.onDidChange(this.resetFormatters);
    packageWatcher.onDidCreate(this.resetFormatters);
    packageWatcher.onDidDelete(this.resetFormatters);

    const configurationWatcher = workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("prettier.enable")) {
        this.loggingService.logWarning(RESTART_TO_ENABLE);
      } else if (event.affectsConfiguration("prettier")) {
        this.resetFormatters();
      }
    });

    const prettierConfigWatcher = workspace.createFileSystemWatcher(
      `**/{${PRETTIER_CONFIG_FILES.join(",")}}`
    );
    prettierConfigWatcher.onDidChange(this.prettierConfigChanged);
    prettierConfigWatcher.onDidCreate(this.prettierConfigChanged);
    prettierConfigWatcher.onDidDelete(this.prettierConfigChanged);

    const textEditorChange = window.onDidChangeActiveTextEditor(
      this.handleActiveTextEditorChanged
    );

    const textDocumentOpened = workspace.onDidOpenTextDocument(
      this.handleTextDocumentOpened
    );

    const textDocumentSaved = workspace.onDidSaveTextDocument(
      this.handleTextDocumentSaved
    );

    const windowStateChanged = window.onDidChangeWindowState(
      this.handleWindowStateChanged
    );

    this.handleActiveTextEditorChanged(window.activeTextEditor);

    return [
      packageWatcher,
      configurationWatcher,
      prettierConfigWatcher,
      textEditorChange,
      textDocumentOpened,
      textDocumentSaved,
      windowStateChanged,
    ];
  }

  private prettierConfigChanged = async (uri: Uri) => this.resetFormatters(uri);

  private resetFormatters = async (uri?: Uri) => {
    if (uri) {
      const workspaceFolder = workspace.getWorkspaceFolder(uri);
      this.registeredWorkspaces.delete(workspaceFolder?.uri.fsPath ?? "global");
    } else {
      // VS Code config change, reset everything
      this.registeredWorkspaces.clear();
    }
    this.statusBar.update(FormatterStatus.Ready);
  };

  private handleTextDocumentOpened = async (document: TextDocument) => {
    this.checkIfUserConfigIsUsed();
    if (!this.useUserConfig) return;

    if (!document.isDirty) {
      await commands.executeCommand("editor.action.formatDocument");
      await commands.executeCommand("workbench.action.files.save");
    }
  };

  private handleTextDocumentSaved = async (textDocument: TextDocument) => {
    this.checkIfUserConfigIsUsed();
    if (!this.useUserConfig) return;

    const filePath = textDocument.uri.fsPath;
    this.visitedFiles[filePath] = { position: 0, isDirty: false };
  };

  private handleWindowStateChanged = async (state: WindowState) => {
    if (this.lastActiveTextEditor)
      this.handleLeaveTextEditor(this.lastActiveTextEditor);

    this.checkIfUserConfigIsUsed();
    if (!this.useUserConfig) return;

    try {
      for (const filePath in this.visitedFiles) {
        const fileState = this.visitedFiles[filePath];
        if (!fileState.isDirty)
          await this.formatFileExternally(filePath, !state.focused);
      }
    } catch (e) {
      window.showErrorMessage(e);
    }
  };

  private handleLeaveTextEditor = async (textEditor: TextEditor) => {
    textEditor.document.save();
    const filePath = textEditor.document.uri.fsPath;
    await this.formatFileExternally(filePath, true);
    this.visitedFiles[filePath] = { position: 0, isDirty: false };
  };

  private formatFileExternally = async (
    filePath: string,
    useUserConfig: boolean
  ) => {
    const config = !useUserConfig ? "" : " --config " + USER_CONFIG_PATH;
    const cmd = "prettier.cmd --write" + config + ' "' + filePath + '"';
    await execShell(cmd);
  };

  private handleActiveTextEditorChanged = async (
    textEditor: TextEditor | undefined
  ) => {
    if (!textEditor) {
      this.statusBar.hide();
      return;
    }

    const { document } = textEditor;
    if (document.uri.scheme !== "file") {
      this.statusBar.hide();
      return;
    }
    const workspaceFolder = workspace.getWorkspaceFolder(document.uri);

    if (this.lastActiveTextEditor)
      this.handleLeaveTextEditor(this.lastActiveTextEditor);
    this.lastActiveTextEditor = textEditor;

    const prettierInstance = await this.moduleResolver.getPrettierInstance(
      workspaceFolder?.uri.fsPath,
      {
        showNotifications: true,
      }
    );

    const isRegistered = this.registeredWorkspaces.has(
      workspaceFolder?.uri.fsPath ?? "global"
    );

    this.checkIfUserConfigIsUsed();

    if (
      !this.useUserConfig &&
      this.userConfigAvailable &&
      this.autoSaveAfterDelay
    )
      window.showWarningMessage(
        "User config was found at " +
          USER_CONFIG_PATH +
          ". At the same time, auto save is set to afterDelay. " +
          "This combination is known to not work well, so user config will be ignored. " +
          "To stop this warning from appearing, " +
          "remove the user config, switch auto save to another mode, or disable auto save."
      );

    // Already registered and no instances means that the user
    // already blocked the execution so we don't do anything
    if (isRegistered && !prettierInstance) {
      return;
    }

    // If there isn't an instance here, it is the first time trying to load
    // prettier and the user denied. Log the deny and mark as registered.
    if (!prettierInstance) {
      this.loggingService.logError(
        "The Prettier extension is blocked from execution in this project."
      );
      //this.notificationService.showErrorMessage(INVALID_PRETTIER_CONFIG);
      this.statusBar.update(FormatterStatus.Disabled);
      this.registeredWorkspaces.add(workspaceFolder?.uri.fsPath ?? "global");
      return;
    }

    const { rangeLanguageSelector, languageSelector } = await this.selectors(
      prettierInstance
    );

    if (!isRegistered) {
      this.statusBar.update(FormatterStatus.Loading);

      this.userEditProvider = new PrettierEditProvider(
        this.useUserConfig,
        this.provideEdits
      );

      this.rangeFormatterHandler = languages.registerDocumentRangeFormattingEditProvider(
        rangeLanguageSelector,
        this.userEditProvider
      );
      this.formatterHandler = languages.registerDocumentFormattingEditProvider(
        languageSelector,
        this.userEditProvider
      );
      this.registeredWorkspaces.add(workspaceFolder?.uri.fsPath ?? "global");

      this.loggingService.logInfo(
        `Enabling prettier for languages: ${languageSelector
          .map((s) => s.language)
          .filter((v) => v !== undefined)
          .join(", ")}`
      );

      this.loggingService.logInfo(
        `Enabling prettier for ranged languages selectors: ${rangeLanguageSelector
          .map((s) => s.language)
          .filter((v) => v !== undefined)
          .join(", ")}`
      );

      this.loggingService.logInfo(
        `Enabling prettier for patterns: ${languageSelector
          .map((s) => s.pattern)
          .filter((v) => v !== undefined)
          .join(", ")}`
      );
    }

    const score = languages.match(languageSelector, document);
    const isFormatterEnabled = isDefaultFormatterOrUnset(document.uri);

    if (!isFormatterEnabled) {
      this.statusBar.update(FormatterStatus.Disabled);
    } else if (score > 0) {
      this.statusBar.update(FormatterStatus.Ready);
    } else {
      this.statusBar.hide();
    }
  };

  public dispose = () => {
    this.moduleResolver.dispose();
    this.formatterHandler?.dispose();
    this.rangeFormatterHandler?.dispose();
    this.formatterHandler = undefined;
    this.rangeFormatterHandler = undefined;
  };

  /**
   * Build formatter selectors
   */
  private selectors = async (
    prettierInstance: PrettierModule
  ): Promise<ISelectors> => {
    const allLanguages = await getSupportedLanguages(prettierInstance);

    const allExtensions = await getSupportedFileExtensions(prettierInstance);

    const { documentSelectors } = getConfig();

    const allRangeLanguages = getRangeSupportedLanguages();

    // Language selector for file extensions
    const extensionLanguageSelector: DocumentFilter[] =
      allExtensions.length === 0
        ? []
        : [
            {
              pattern: `**/*.{${allExtensions
                .map((e) => e.substring(1))
                .join(",")}}`,
            },
          ];

    const customLanguageSelectors: DocumentFilter[] = [];
    documentSelectors.forEach((pattern) => {
      customLanguageSelectors.push({
        pattern,
      });
    });

    // Language selectors for language IDs
    const globalLanguageSelector: DocumentFilter[] = allLanguages.map((l) => ({
      language: l,
    }));
    const globalRangeLanguageSelector: DocumentFilter[] = allRangeLanguages.map(
      (l) => ({ language: l })
    );

    const languageSelector = globalLanguageSelector
      .concat(customLanguageSelectors)
      .concat(extensionLanguageSelector);

    const rangeLanguageSelector = globalRangeLanguageSelector;

    return { languageSelector, rangeLanguageSelector };
  };

  private provideEdits = async (
    document: TextDocument,
    useUserConfig: boolean,
    options?: RangeFormattingOptions
  ): Promise<TextEdit[]> => {
    const hrStart = process.hrtime();
    const result = await this.format(
      document.getText(),
      document,
      useUserConfig,
      options
    );
    if (!result) {
      // No edits happened, return never so VS Code can try other formatters
      return [];
    }
    const hrEnd = process.hrtime(hrStart);
    this.loggingService.logInfo(
      `Formatting completed in ${hrEnd[1] / 1000000}ms.`
    );
    return [TextEdit.replace(this.fullDocumentRange(document), result)];
  };

  /**
   * Format the given text with user's configuration.
   * @param text Text to format
   * @param path formatting file's path
   * @returns {string} formatted text
   */
  private async format(
    text: string,
    { fileName, languageId, uri, isUntitled }: TextDocument,
    useUserConfig: boolean,
    rangeFormattingOptions?: RangeFormattingOptions
  ): Promise<string | undefined> {
    this.loggingService.logInfo(`Formatting ${fileName}`);

    const vscodeConfig = getConfig(uri);

    try {
      const hasConfig = await this.configResolver.checkHasPrettierConfig(
        fileName
      );

      if (!isUntitled && !hasConfig && vscodeConfig.requireConfig) {
        this.loggingService.logInfo(
          "Require config set to true and no config present. Skipping file."
        );
        this.statusBar.update(FormatterStatus.Disabled);
        return;
      }
    } catch (error) {
      this.loggingService.logError(
        "Invalid prettier configuration file detected.",
        error
      );
      this.notificationService.showErrorMessage(INVALID_PRETTIER_CONFIG);
      this.statusBar.update(FormatterStatus.Error);
      return;
    }

    const ignorePath = this.ignoreResolver.getIgnorePath(fileName);

    const prettierInstance = await this.moduleResolver.getPrettierInstance(
      fileName,
      {
        showNotifications: true,
      }
    );

    if (!prettierInstance) {
      this.loggingService.logError(
        "Prettier could not be loaded. See previous logs for more information."
      );
      this.notificationService.showErrorMessage(UNABLE_TO_LOAD_PRETTIER);
      this.statusBar.update(FormatterStatus.Error);
      return;
    }

    let fileInfo: prettier.FileInfoResult | undefined;
    if (fileName) {
      fileInfo = await prettierInstance.getFileInfo(fileName, {
        ignorePath,
        resolveConfig: true,
        withNodeModules: vscodeConfig.withNodeModules,
      });
      this.loggingService.logInfo("File Info:", fileInfo);
    }

    if (fileInfo && fileInfo.ignored) {
      this.loggingService.logInfo("File is ignored, skipping.");
      this.statusBar.update(FormatterStatus.Ignore);
      return;
    }

    let parser: prettier.BuiltInParserName | string | undefined;
    if (fileInfo && fileInfo.inferredParser) {
      parser = fileInfo.inferredParser;
    } else if (languageId !== "plaintext") {
      // Don't attempt VS Code language for plaintext because we never have
      // a formatter for plaintext and most likely the reason for this is
      // somebody has registered a custom file extension without properly
      // configuring the parser in their prettier config.
      this.loggingService.logWarning(
        `Parser not inferred, trying VS Code language.`
      );
      parser = await getParserFromLanguageId(prettierInstance, uri, languageId);
    }

    if (!parser) {
      this.loggingService.logError(
        `Failed to resolve a parser, skipping file. If you registered a custom file extension, be sure to configure the parser.`
      );
      this.statusBar.update(FormatterStatus.Error);
      return;
    }

    let configPath: string | undefined;
    try {
      if (useUserConfig) configPath = USER_CONFIG_PATH;
      else
        configPath = (await prettier.resolveConfigFile(fileName)) ?? undefined;
    } catch (error) {
      this.loggingService.logError(
        `Error resolving prettier configuration for ${fileName}`,
        error
      );
      this.statusBar.update(FormatterStatus.Error);
      return;
    }

    const {
      options: prettierOptions,
      error,
    } = await this.configResolver.getPrettierOptions(
      fileName,
      parser as prettier.BuiltInParserName,
      vscodeConfig,
      {
        config: vscodeConfig.configPath
          ? getWorkspaceRelativePath(fileName, vscodeConfig.configPath)
          : configPath,
        editorconfig: vscodeConfig.useEditorConfig,
      },
      rangeFormattingOptions
    );

    if (error) {
      this.loggingService.logError(
        `Error resolving prettier configuration for ${fileName}`,
        error
      );
      this.statusBar.update(FormatterStatus.Error);
      return;
    }

    this.loggingService.logInfo("Prettier Options:", prettierOptions);

    try {
      const formattedText = prettierInstance.format(text, prettierOptions);
      this.statusBar.update(FormatterStatus.Success);

      return formattedText;
    } catch (error) {
      this.loggingService.logError("Error formatting document.", error);
      this.statusBar.update(FormatterStatus.Error);

      return text;
    }
  }

  private checkIfUserConfigIsUsed(): void {
    const autoSaveMode = workspace
      .getConfiguration()
      .get<string>("files.autoSave");
    this.autoSaveAfterDelay = autoSaveMode == "afterDelay";
    this.userConfigAvailable = fs.existsSync(USER_CONFIG_PATH);
    this.useUserConfig = !this.autoSaveAfterDelay && this.userConfigAvailable;
    if (this.userEditProvider)
      this.userEditProvider.setUseUserConfig(this.useUserConfig);
  }

  private fullDocumentRange(document: TextDocument): Range {
    const lastLineId = document.lineCount - 1;
    return new Range(0, 0, lastLineId, document.lineAt(lastLineId).text.length);
  }
}
