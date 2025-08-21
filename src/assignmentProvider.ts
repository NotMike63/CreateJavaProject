import * as vscode from 'vscode';
import * as fs from 'fs';
import fetch from 'node-fetch';
import * as path from 'path';
import * as os from 'os';
import * as unzip from 'unzip-stream';
import { Parser, parseStringPromise } from 'xml2js';
import { copyJarsToDir } from './createProject';

type AssignmentItemData = {
    label: string;
    description: string;
    url: string;
};

class AssignmentTreeItem extends vscode.TreeItem {
    children?: AssignmentTreeItem[];
    itemData?: AssignmentItemData;

    constructor(
        label: string,
        collapsibleState: vscode.TreeItemCollapsibleState,
        iconId?: string,
        children?: AssignmentTreeItem[],
        itemData?: AssignmentItemData
    ) {
        super(label, collapsibleState);
        this.children = children;
        this.itemData = itemData;
        if (iconId) {
            this.iconPath = new vscode.ThemeIcon(iconId);
        }
        if (itemData) {
            this.contextValue = 'assignment';
            this.description = itemData.description;
            this.tooltip = itemData.description;
        }
    }
}

export class AssignmentProvider implements vscode.TreeDataProvider<AssignmentTreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<AssignmentTreeItem | undefined | null | void> = new vscode.EventEmitter();
    readonly onDidChangeTreeData: vscode.Event<AssignmentTreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: AssignmentTreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: AssignmentTreeItem): Thenable<AssignmentTreeItem[]> {
        if (element) {
            return Promise.resolve(element.children || []);
        }
        return this.fetchData();
    }

    private async fetchSite(url: string): Promise<{ label: string; packages: AssignmentItemData[] }> {
        const resp = await fetch(url);
        if (!resp.ok) {
            vscode.window.showErrorMessage(`Failed to fetch assignments from ${url}. Check the URL and your internet connection.`);
            return { label: 'Error', packages: [] };
        }

        const content = await resp.text();
        try {
            const result = await parseStringPromise(content);
            const siteName = result.snarf_site.$.name;
            const packages = result.snarf_site.package.map((p: any) => ({
                label: p.$.name,
                description: p.description[0],
                url: p.entry[0].$.url,
            }));
            return { label: siteName, packages };
        } catch (error) {
            vscode.window.showErrorMessage('Failed to parse assignment data.');
            return { label: 'Error', packages: [] };
        }
    }

    private async fetchData(): Promise<AssignmentTreeItem[]> {
        const config = vscode.workspace.getConfiguration('itsc2214');
        const downloadURL = config.get<string>('downloadURL');

        if (!downloadURL) {
            vscode.window.showWarningMessage('Assignment download URL is not configured.');
            return [];
        }

        const { label, packages } = await this.fetchSite(downloadURL);

        const assignmentItems = packages.map(pkg =>
            new AssignmentTreeItem(pkg.label, vscode.TreeItemCollapsibleState.None, undefined, undefined, pkg)
        );

        assignmentItems.sort((a, b) => (a.label! as string).localeCompare(b.label! as string));

        const rootItem = new AssignmentTreeItem(label, vscode.TreeItemCollapsibleState.Expanded, 'project', assignmentItems);
        return [rootItem];
    }
}

async function downloadAndUnzip(itemData: AssignmentItemData, context: vscode.ExtensionContext): Promise<vscode.Uri | undefined> {
    const itsc2214Dir = context.globalState.get<string>('itsc2214Dir');
    if (!itsc2214Dir) {
        vscode.window.showErrorMessage('ITSC2214 project directory not set. Please create a project first.');
        return undefined;
    }

    const projectUri = vscode.Uri.joinPath(vscode.Uri.file(itsc2214Dir), itemData.label.replace(/[^a-zA-Z0-9- ]/g, '').replace(/\s+/g, '-'));

    try {
        await vscode.workspace.fs.stat(projectUri);
        const choice = await vscode.window.showWarningMessage(`Directory "${itemData.label}" already exists. Overwrite?`, "Yes", "No");
        if (choice !== 'Yes') {
            return undefined;
        }
        await vscode.workspace.fs.delete(projectUri, { recursive: true });
    } catch (error) {
        
    }

    await vscode.workspace.fs.createDirectory(projectUri);

    const resp = await fetch(itemData.url);
    if (!resp.ok) {
        vscode.window.showErrorMessage(`Failed to download assignment: ${resp.statusText}`);
        return undefined;
    }

    const tempDirUri = vscode.Uri.file(fs.mkdtempSync(path.join(os.tmpdir(), 'itsc2214-unzip-')));

    return new Promise<vscode.Uri | undefined>((resolve, reject) => {
        const extractStream = unzip.Extract({ path: tempDirUri.fsPath });
        resp.body.pipe(extractStream);
        extractStream.on('error', reject);
        extractStream.on('finish', async () => {
            try {
                const macosxUri = vscode.Uri.joinPath(tempDirUri, '__MACOSX');
                try {
                    await vscode.workspace.fs.delete(macosxUri, { recursive: true });
                } catch (e) {
                    
                }

                let projectRootUri = tempDirUri;
                const entries = await vscode.workspace.fs.readDirectory(tempDirUri);
                if (entries.length === 1 && entries[0][1] === vscode.FileType.Directory) {
                    projectRootUri = vscode.Uri.joinPath(tempDirUri, entries[0][0]);
                }

                const projectFiles = await vscode.workspace.fs.readDirectory(projectRootUri);
                for (const [fileName] of projectFiles) {
                    const oldPath = vscode.Uri.joinPath(projectRootUri, fileName);
                    const newPath = vscode.Uri.joinPath(projectUri, fileName);
                    await vscode.workspace.fs.rename(oldPath, newPath);
                }

                await vscode.workspace.fs.delete(tempDirUri, { recursive: true });

                await copyJarsToDir(projectUri, 'lib', context);
                
                resolve(projectUri);
            } catch (e) {
                reject(e);
            }
        });
    });
}

export async function downloadAssignment(item: AssignmentTreeItem, context: vscode.ExtensionContext) {
    if (!item || !item.itemData) {
        return;
    }
    const itemData = item.itemData;

    const projectUri = await vscode.window.withProgress(
        {
            location: { viewId: 'itsc2214ExplorerView' },
            title: `Downloading ${itemData.label}...`,
            cancellable: false
        },
        () => downloadAndUnzip(itemData, context)
    );

    if (projectUri) {
        await vscode.commands.executeCommand('vscode.openFolder', projectUri, { forceNewWindow: true });
    }
}

export async function setDownloadUrl() {
    const config = vscode.workspace.getConfiguration('itsc2214');
    const currentUrl = config.get<string>('downloadURL') || '';

    const newUrl = await vscode.window.showInputBox({
        prompt: 'Enter the assignment download URL (snarf.json)',
        value: currentUrl,
        validateInput: value => (!value || value.trim().length === 0) ? 'URL cannot be empty.' : null
    });

    if (newUrl) {
        await config.update('downloadURL', newUrl, true);
        vscode.window.showInformationMessage('Download URL updated.');
        vscode.commands.executeCommand('itsc2214.refreshAssignments');
    }
}

export async function setUploadUrl() {
    const config = vscode.workspace.getConfiguration('itsc2214');
    const currentUrl = config.get<string>('uploadURL') || '';

    const newUrl = await vscode.window.showInputBox({
        prompt: 'Enter the assignment upload URL (Web-CAT)',
        value: currentUrl,
        validateInput: value => (!value || value.trim().length === 0) ? 'URL cannot be empty.' : null
    });

    if (newUrl) {
        await config.update('uploadURL', newUrl, true);
        vscode.window.showInformationMessage('Upload URL updated.');
        vscode.commands.executeCommand('itsc2214.refreshUploads');
    }
}

export function openView() {
    vscode.commands.executeCommand('workbench.view.extension.itsc2214Explorer');
}
