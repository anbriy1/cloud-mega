const crypto = require('crypto');

if (!globalThis.crypto) {
    globalThis.crypto = crypto.webcrypto;
}
if (!global.crypto) {
    global.crypto = crypto.webcrypto;
}

const express = require('express');
const formidable = require('formidable');
const { Storage } = require('megajs');
const fs = require('fs');
const path = require('path');

const app = express();

app.use(express.json());

// In-memory token store (for demo purposes). In production, use a DB/session manager.
const tokenToCredentials = new Map();

function generateToken() {
    return crypto.randomBytes(24).toString('hex');
}

function getCredentialsFromRequest(req) {
    // Authorization: Bearer <token>
    const authHeader = req.headers['authorization'] || '';
    const parts = authHeader.split(' ');
    let token = '';
    if (parts.length === 2 && parts[0] === 'Bearer') {
        token = parts[1];
    }
    // Fallback: token in query (for file downloads via window.open)
    if (!token && req.query && req.query.token) {
        token = String(req.query.token);
    }
    if (!token) {
        return null;
    }
    return tokenToCredentials.get(token) || null;
}

async function getStorage(req) {
    const creds = getCredentialsFromRequest(req);
    if (!creds) {
        throw new Error('Unauthorized: missing or invalid token');
    }
    return new Promise((resolve, reject) => {
        try {
            const storage = new Storage({
                email: creds.email,
                password: creds.password
            });
            
            storage.ready.then(() => {
                console.log('Connected to MEGA');
                resolve(storage);
            }).catch(reject);
        } catch (err) {
            reject(err);
        }
    });
}

function findNodeById(rootNode, targetId) {
    if (!rootNode) return null;
    if (rootNode.nodeId === targetId) return rootNode;
    const children = rootNode.children || [];
    for (const child of children) {
        if (child.nodeId === targetId) return child;
        if (child.directory) {
            const found = findNodeById(child, targetId);
            if (found) return found;
        }
    }
    return null;
}

// Login endpoint: verifies MEGA credentials and issues a token
app.post('/api/login', async (req, res) => {
    try {
        const { email, password } = req.body || {};
        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password are required' });
        }
        // Try to connect with provided credentials
        const storage = new Storage({ email, password });
        await storage.ready;
        // If connected, issue token and cache credentials
        const token = generateToken();
        tokenToCredentials.set(token, { email, password });
        // Optionally, clean up storage instance (we reconnect per request)
        res.json({ token, email });
    } catch (error) {
        console.error('Login failed:', error);
        res.status(401).json({ error: 'Invalid email or password' });
    }
});

app.get('/api/files', async (req, res) => {
    try {
        const storage = await getStorage(req);
        const root = storage.root;
        const folderId = req.query.folderId ? String(req.query.folderId) : '';
        const container = folderId ? findNodeById(root, folderId) : root;
        if (!container) {
            return res.status(404).json({ error: 'Folder not found' });
        }
        if (!container.directory) {
            return res.status(400).json({ error: 'Not a folder' });
        }
        
        const files = [];
        const folders = [];
        
        function processNode(node) {
            if (node.directory) {
                folders.push({
                    name: node.name,
                    id: node.nodeId,
                    type: 'folder',
                    size: null,
                    created: node.ctime
                });
            } else {
                files.push({
                    name: node.name,
                    id: node.nodeId,
                    type: 'file',
                    size: node.size,
                    created: node.ctime,
                    downloadUrl: `/api/download/${node.nodeId}`
                });
            }
        }
        
        const children = container.children || [];
        
        for (const node of children) {
            processNode(node);
        }
        
        res.json({ files, folders });
    } catch (error) {
        console.error('Error getting file list:', error);
        if (String(error.message).startsWith('Unauthorized')) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/download/:fileId', async (req, res) => {
    try {
        const storage = await getStorage(req);
        const root = storage.root;
        const fileId = req.params.fileId;
        
        const file = findNodeById(root, fileId);
        
        if (!file || file.directory) {
            return res.status(404).send('File not found');
        }
        
        const download = file.download();
        
        res.setHeader('Content-Disposition', `attachment; filename="${file.name}"`);
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Length', file.size);
        
        download.on('data', (chunk) => {
            res.write(chunk);
        });
        
        download.on('end', () => {
            res.end();
        });
        
        download.on('error', (err) => {
            console.error('Download error:', err);
            res.status(500).send('File download error');
        });
    } catch (error) {
        console.error('File download error:', error);
        if (String(error.message).startsWith('Unauthorized')) {
            return res.status(401).send('Unauthorized');
        }
        res.status(500).send('File download error: ' + error.message);
    }
});

app.post('/api/folder', async (req, res) => {
    try {
        const { name, parentId } = req.body;
        
        if (!name) {
            return res.status(400).json({ error: 'Folder name is required' });
        }
        
        const storage = await getStorage(req);
        const root = storage.root;
        let parent = root;
        if (parentId) {
            const node = findNodeById(root, String(parentId));
            if (!node) return res.status(404).json({ error: 'Parent folder not found' });
            if (!node.directory) return res.status(400).json({ error: 'Parent is not a folder' });
            parent = node;
        }
        
        const folder = await parent.mkdir(name);
        
        res.json({ 
            success: true, 
            message: `Folder "${name}" created successfully`,
            folder: {
                name: folder.name,
                id: folder.nodeId,
                type: 'folder'
            }
        });
    } catch (error) {
        console.error('Error creating folder:', error);
        if (String(error.message).startsWith('Unauthorized')) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        res.status(500).json({ error: error.message });
    }
});

app.post('/upload', async (req, res) => {
    // Check auth before parsing large body
    try {
        const creds = getCredentialsFromRequest(req);
        if (!creds) {
            return res.status(401).send('Unauthorized');
        }
    } catch (e) {
        return res.status(401).send('Unauthorized');
    }
    const form = new formidable.IncomingForm({
        maxFileSize: 100 * 1024 * 1024 * 1024,
        keepExtensions: true
    });

    form.parse(req, async (err, fields, files) => {
        if (err) {
            console.error('Form parsing error:', err);
            return res.status(500).send('File upload error: ' + err.message);
        }

        const file = files.file;
        if (!file || !Array.isArray(file) && !file.filepath) {
            return res.status(400).send('File not found');
        }

        const filePath = Array.isArray(file) ? file[0].filepath : file.filepath;
        const fileName = Array.isArray(file) ? file[0].originalFilename : file.originalFilename;
        const folderIdRaw = fields.folderId;
        const folderId = Array.isArray(folderIdRaw) ? String(folderIdRaw[0]) : (folderIdRaw ? String(folderIdRaw) : '');

        if (!filePath || !fs.existsSync(filePath)) {
            return res.status(400).send('File not found on server');
        }

        try {
            console.log('Connecting to MEGA...');
            const storage = await getStorage(req);

            console.log('Getting file info:', fileName);
            const stats = await fs.promises.stat(filePath);
            const fileSize = stats.size;
            console.log('File size:', fileSize, 'bytes');

            console.log('Uploading file to MEGA...');
            
            const fileBuffer = await fs.promises.readFile(filePath);
            
            // Choose destination: specified folder or root
            let destination = storage;
            if (folderId) {
                const parentNode = findNodeById(storage.root, folderId);
                if (!parentNode) {
                    console.warn('Specified folder not found, uploading to root');
                } else if (!parentNode.directory) {
                    console.warn('Specified node is not a folder, uploading to root');
                } else {
                    destination = parentNode;
                }
            }

            const upload = destination.upload({
                name: fileName,
                size: fileSize,
                allowUploadBuffering: true
            });

            upload.write(fileBuffer);
            upload.end();

            upload.on('error', (err) => {
                console.error('MEGA upload error:', err);
            });

            upload.on('progress', (progress) => {
                console.log('Upload progress:', progress);
            });

            console.log('Waiting for upload to complete...');
            await upload.complete;
            console.log('Upload completed!');
            
            fs.unlink(filePath, (err) => {
                if (err) console.error('Error deleting temporary file:', err);
            });

            console.log('File uploaded successfully:', fileName);
            res.send('File "' + fileName + '" uploaded to MEGA successfully!');
        } catch (error) {
            console.error('MEGA upload error:', error);
            
            if (fs.existsSync(filePath)) {
                fs.unlink(filePath, (err) => {
                    if (err) console.error('Error deleting temporary file:', err);
                });
            }
            
            res.status(500).send('MEGA upload error: ' + error.message);
        }
    });
});

// Serve static files only in local development
// On Vercel, static files are handled by vercel.json routing
if (process.env.VERCEL !== '1') {
    app.use(express.static('.'));
    app.use(express.static('public'));
}

// Export for Vercel serverless
module.exports = app;

// For local development
if (require.main === module) {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => console.log(`Server started: http://localhost:${PORT}`));
}
