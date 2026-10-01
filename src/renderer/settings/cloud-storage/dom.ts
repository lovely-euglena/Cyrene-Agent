// 云存储设置面板 DOM 引用。

export const cloudStorageList = document.getElementById("cloud-storage-list") as HTMLElement;
export const cloudStorageAddButton = document.getElementById("cloud-storage-add") as HTMLButtonElement;
export const cloudStorageEditor = document.getElementById("cloud-storage-editor") as HTMLElement;
export const cloudStorageEditorTitle = document.getElementById("cloud-storage-editor-title") as HTMLElement;
export const cloudStorageStatus = document.getElementById("cloud-storage-status") as HTMLElement;

export const cloudStorageName = document.getElementById("cloud-storage-name") as HTMLInputElement;
export const cloudStorageProtocol = document.getElementById("cloud-storage-protocol") as HTMLSelectElement;

// ftp / ftps / sftp 共用连接字段
export const cloudStorageHost = document.getElementById("cloud-storage-host") as HTMLInputElement;
export const cloudStoragePort = document.getElementById("cloud-storage-port") as HTMLInputElement;
export const cloudStorageUsername = document.getElementById("cloud-storage-username") as HTMLInputElement;
export const cloudStorageRoot = document.getElementById("cloud-storage-root") as HTMLInputElement;
export const cloudStoragePassword = document.getElementById("cloud-storage-password") as HTMLInputElement;
export const cloudStoragePassive = document.getElementById("cloud-storage-passive") as HTMLInputElement;
export const cloudStorageTlsMode = document.getElementById("cloud-storage-tls-mode") as HTMLSelectElement;
export const cloudStorageAllowInvalidCert = document.getElementById("cloud-storage-allow-invalid-cert") as HTMLInputElement;
export const cloudStorageAuthType = document.getElementById("cloud-storage-auth-type") as HTMLSelectElement;
export const cloudStoragePrivateKey = document.getElementById("cloud-storage-private-key") as HTMLInputElement;
export const cloudStoragePassphrase = document.getElementById("cloud-storage-passphrase") as HTMLInputElement;

// WebDAV
export const cloudStorageWebdavUrl = document.getElementById("cloud-storage-webdav-url") as HTMLInputElement;
export const cloudStorageWebdavUsername = document.getElementById("cloud-storage-webdav-username") as HTMLInputElement;
export const cloudStorageWebdavPassword = document.getElementById("cloud-storage-webdav-password") as HTMLInputElement;
export const cloudStorageWebdavAuthType = document.getElementById("cloud-storage-webdav-auth-type") as HTMLSelectElement;
export const cloudStorageWebdavRoot = document.getElementById("cloud-storage-webdav-root") as HTMLInputElement;
export const cloudStorageWebdavAllowInvalidCert = document.getElementById("cloud-storage-webdav-allow-invalid-cert") as HTMLInputElement;

// S3 / 兼容对象存储
export const cloudStorageS3Bucket = document.getElementById("cloud-storage-s3-bucket") as HTMLInputElement;
export const cloudStorageS3Endpoint = document.getElementById("cloud-storage-s3-endpoint") as HTMLInputElement;
export const cloudStorageS3Region = document.getElementById("cloud-storage-s3-region") as HTMLInputElement;
export const cloudStorageS3PathStyle = document.getElementById("cloud-storage-s3-path-style") as HTMLInputElement;
export const cloudStorageS3AccessKey = document.getElementById("cloud-storage-s3-access-key") as HTMLInputElement;
export const cloudStorageS3SecretKey = document.getElementById("cloud-storage-s3-secret-key") as HTMLInputElement;
export const cloudStorageS3Prefix = document.getElementById("cloud-storage-s3-prefix") as HTMLInputElement;

export const cloudStorageSaveButton = document.getElementById("cloud-storage-save") as HTMLButtonElement;
export const cloudStorageTestButton = document.getElementById("cloud-storage-test") as HTMLButtonElement;
export const cloudStorageCancelButton = document.getElementById("cloud-storage-cancel") as HTMLButtonElement;
