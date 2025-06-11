// IndexedDB utility module for handling large data storage
// This module provides a more robust alternative to localStorage for storing upload data

// Constants
const DB_NAME = 'uploadsDB';
const UPLOADS_STORE = 'pendingUploads';

// Initialize the database
function initDB() {
    return new Promise((resolve, reject) => {
        // First, try to open the database without specifying a version to get the current version
        const checkVersionRequest = indexedDB.open(DB_NAME);

        checkVersionRequest.onerror = (event) => {
            console.error('IndexedDB version check error:', event.target.error);
            reject(event.target.error);
        };

        checkVersionRequest.onsuccess = (event) => {
            const db = event.target.result;
            const currentVersion = db.version;
            db.close();

            // Now open with the correct version
            const request = indexedDB.open(DB_NAME, currentVersion);

            request.onerror = (event) => {
                console.error('IndexedDB error:', event.target.error);
                reject(event.target.error);
            };

            request.onsuccess = (event) => {
                const db = event.target.result;

                // Check if our store exists, if not we need to upgrade
                if (!db.objectStoreNames.contains(UPLOADS_STORE)) {
                    db.close();
                    // Need to upgrade to create our store
                    const upgradeRequest = indexedDB.open(DB_NAME, currentVersion + 1);

                    upgradeRequest.onerror = (event) => {
                        console.error('IndexedDB upgrade error:', event.target.error);
                        reject(event.target.error);
                    };

                    upgradeRequest.onsuccess = (event) => {
                        resolve(event.target.result);
                    };

                    upgradeRequest.onupgradeneeded = (event) => {
                        const db = event.target.result;
                        // Create object store for pending uploads
                        const store = db.createObjectStore(UPLOADS_STORE, { keyPath: 'id' });
                        store.createIndex('projectId', 'projectId', { unique: false });
                    };
                } else {
                    resolve(db);
                }
            };
        };

        checkVersionRequest.onupgradeneeded = (event) => {
            const db = event.target.result;

            // Create object store for pending uploads
            if (!db.objectStoreNames.contains(UPLOADS_STORE)) {
                const store = db.createObjectStore(UPLOADS_STORE, { keyPath: 'id' });
                store.createIndex('projectId', 'projectId', { unique: false });
            }
        };
    });
}

// Save pending uploads for a project
function savePendingUploadsToIndexedDB(projectId, projectUploads) {
    return new Promise((resolve, reject) => {
        initDB().then(db => {
            const transaction = db.transaction([UPLOADS_STORE], 'readwrite');
            const store = transaction.objectStore(UPLOADS_STORE);

            // First, delete existing entries for this project
            const index = store.index('projectId');
            const request = index.openKeyCursor(IDBKeyRange.only(projectId));

            request.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                    store.delete(cursor.primaryKey);
                    cursor.continue();
                } else {
                    // After deleting, add new entries
                    const entries = Object.entries(projectUploads);
                    if (entries.length === 0) {
                        transaction.oncomplete = () => resolve();
                        return;
                    }

                    let completed = 0;
                    entries.forEach(([taskId, uploadInfo]) => {
                        // Add projectId to each entry and use taskId as part of the key
                        const entry = {
                            id: `${projectId}_${taskId}`,
                            taskId: taskId,
                            projectId: projectId,
                            ...uploadInfo
                        };

                        const addRequest = store.add(entry);

                        addRequest.onsuccess = () => {
                            completed++;
                            if (completed === entries.length) {
                                // All entries added
                                transaction.oncomplete = () => resolve();
                            }
                        };

                        addRequest.onerror = (event) => {
                            console.error('Error adding entry:', event.target.error);
                            // Continue with other entries even if one fails
                            completed++;
                            if (completed === entries.length) {
                                transaction.oncomplete = () => resolve();
                            }
                        };
                    });
                }
            };

            request.onerror = (event) => {
                console.error('Error accessing index:', event.target.error);
                reject(event.target.error);
            };

            transaction.onerror = (event) => {
                console.error('Transaction error:', event.target.error);
                reject(event.target.error);
            };
        }).catch(error => {
            console.error('Failed to initialize IndexedDB:', error);
            reject(error);
        });
    });
}

// Load pending uploads for a project
function loadPendingUploadsFromIndexedDB(projectId) {
    return new Promise((resolve, reject) => {
        initDB().then(db => {
            const transaction = db.transaction([UPLOADS_STORE], 'readonly');
            const store = transaction.objectStore(UPLOADS_STORE);
            const index = store.index('projectId');
            const request = index.getAll(IDBKeyRange.only(projectId));

            request.onsuccess = (event) => {
                const results = event.target.result;
                const projectUploads = {};

                // Convert array of entries back to object with taskId as key
                results.forEach(entry => {
                    projectUploads[entry.taskId] = {
                        ...entry,
                        projectId: entry.projectId
                    };
                });

                resolve(projectUploads);
            };

            request.onerror = (event) => {
                console.error('Error loading uploads:', event.target.error);
                reject(event.target.error);
            };
        }).catch(error => {
            console.error('Failed to initialize IndexedDB:', error);
            reject(error);
        });
    });
}

// Delete all pending uploads for a project
function deletePendingUploadsFromIndexedDB(projectId) {
    return new Promise((resolve, reject) => {
        initDB().then(db => {
            const transaction = db.transaction([UPLOADS_STORE], 'readwrite');
            const store = transaction.objectStore(UPLOADS_STORE);
            const index = store.index('projectId');
            const request = index.openKeyCursor(IDBKeyRange.only(projectId));

            request.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                    store.delete(cursor.primaryKey);
                    cursor.continue();
                } else {
                    transaction.oncomplete = () => resolve();
                }
            };

            request.onerror = (event) => {
                console.error('Error deleting uploads:', event.target.error);
                reject(event.target.error);
            };
        }).catch(error => {
            console.error('Failed to initialize IndexedDB:', error);
            reject(error);
        });
    });
}

// Export the functions
window.uploadsDB = {
    savePendingUploads: savePendingUploadsToIndexedDB,
    loadPendingUploads: loadPendingUploadsFromIndexedDB,
    deletePendingUploads: deletePendingUploadsFromIndexedDB
};
