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

async function getStorage() {
    return new Promise((resolve, reject) => {
        try {
            const storage = new Storage({
                email: 'Login',
                password: 'password'
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

app.get('/api/files', async (req, res) => {
    try {
        const storage = await getStorage();
        const root = storage.root;
        
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
        
        const children = root.children || [];
        
        for (const node of children) {
            processNode(node);
        }
        
        res.json({ files, folders });
    } catch (error) {
        console.error('Error getting file list:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/download/:fileId', async (req, res) => {
    try {
        const storage = await getStorage();
        const root = storage.root;
        const fileId = req.params.fileId;
        
        const children = root.children || [];
        const file = children.find(node => node.nodeId === fileId);
        
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
        res.status(500).send('File download error: ' + error.message);
    }
});

app.post('/api/folder', async (req, res) => {
    try {
        const { name } = req.body;
        
        if (!name) {
            return res.status(400).json({ error: 'Folder name is required' });
        }
        
        const storage = await getStorage();
        const root = storage.root;
        
        const folder = await root.mkdir(name);
        
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
        res.status(500).json({ error: error.message });
    }
});

app.post('/upload', async (req, res) => {
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

        if (!filePath || !fs.existsSync(filePath)) {
            return res.status(400).send('File not found on server');
        }

        try {
            console.log('Connecting to MEGA...');
            const storage = await getStorage();

            console.log('Getting file info:', fileName);
            const stats = await fs.promises.stat(filePath);
            const fileSize = stats.size;
            console.log('File size:', fileSize, 'bytes');

            console.log('Uploading file to MEGA...');
            
            const fileBuffer = await fs.promises.readFile(filePath);
            
            const upload = storage.upload({
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

app.use(express.static('public'));

const PORT = 3000;
app.listen(PORT, () => console.log(`Server started: http://localhost:${PORT}`));
