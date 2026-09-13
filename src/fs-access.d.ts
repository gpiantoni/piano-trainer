// File System Access API parts that TypeScript's DOM lib does not declare yet.
// Chrome only (desktop 86+, Android 132+); always feature-detect showDirectoryPicker.

type FileSystemPermissionMode = 'read' | 'readwrite';

interface FileSystemHandle {
  queryPermission(options?: { mode?: FileSystemPermissionMode }): Promise<PermissionState>;
  requestPermission(options?: { mode?: FileSystemPermissionMode }): Promise<PermissionState>;
}

interface Window {
  showDirectoryPicker?(options?: {
    id?: string;
    mode?: FileSystemPermissionMode;
    startIn?: FileSystemHandle | 'documents' | 'downloads' | 'music';
  }): Promise<FileSystemDirectoryHandle>;
}
