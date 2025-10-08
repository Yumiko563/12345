const express = require('express');
const puppeteer = require('puppeteer-core');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Variable global para mantener la página del navegador
let page;

async function startBrowser() {
    console.log('Iniciando navegador...');
    const browser = await puppeteer.launch({
    executablePath: '/usr/bin/google-chrome-stable', // Esta ruta es correcta
    args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--single-process'
    ],
    // ¡Importante para Render! Necesitamos decirle dónde almacenar los datos del navegador
    // para que no sobrecargue el disco efímero.
    userDataDir: '/tmp/puppeteer' 
});

    page = await browser.newPage();

    // Simular un navegador real para pasar las verificaciones
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1920, height: 1080 });

    console.log('Navegando a lmarena.ai...');
    await page.goto('https://lmarena.ai/', { waitUntil: 'networkidle2' });

    // Esperamos a que un elemento clave de la UI esté visible.
    // Esto nos confirma que la página, incluido el desafío de Cloudflare y el sign-up anónimo, ha cargado.
    await page.waitForSelector('textarea[placeholder="Ask me anything..."]', { timeout: 60000 });
    
    console.log('¡Página cargada y sesión lista!');
}

// Endpoint principal para procesar los chats
app.post('/chat', async (req, res) => {
    if (!page) {
        return res.status(503).json({ error: 'El navegador headless no está listo. Inténtalo de nuevo en un momento.' });
    }

    const { modelId, messages } = req.body;
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({ error: 'El campo "messages" es requerido y debe ser un array con contenido.' });
    }

    try {
        // Configuramos la respuesta para que sea un stream
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        
        // Exponemos una función de Node.js que el navegador podrá llamar
        await page.exposeFunction('onDataReceived', (chunk) => {
            // Cada vez que el navegador reciba un trozo de datos, lo escribimos en nuestra respuesta
            res.write(chunk);
        });

        // Este es el código que se ejecutará DENTRO del navegador
        const result = await page.evaluate(async ({ modelId, messages }) => {
            // Esta función se ejecuta en el contexto de la página lmarena.ai
            // por lo que tiene acceso a 'fetch' y al estado del navegador (cookies, etc.)

            // 1. Obtener el token de autenticación de las cookies
            const authCookie = document.cookie.split('; ').find(row => row.startsWith('arena-auth-prod-v1='));
            if (!authCookie) {
                throw new Error("No se encontró la cookie de autenticación.");
            }
            const base64Token = authCookie.split('=')[1];
            const decodedToken = JSON.parse(atob(base64Token));
            const accessToken = decodedToken.access_token;

            // 2. Construir el payload para la API
            // Esto es una simplificación, necesitarás replicar la estructura exacta que viste.
            const payload = {
                // Aquí deberás replicar la estructura de 'create-evaluation'
                // Esto requerirá IDs únicos, etc.
                // Por ahora, lo simplificamos para mostrar el concepto.
                modelAId: modelId || "cb0f1e24-e8e9-4745-aabc-b926ffde7475", // ID de un modelo por defecto
                messages: messages.map(msg => ({
                    id: crypto.randomUUID(),
                    role: msg.role,
                    content: msg.content,
                    status: 'pending'
                })),
                mode: 'direct',
                // ...otros campos necesarios
            };
            
            const response = await fetch('https://lmarena.ai/nextjs-api/stream/create-evaluation', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${accessToken}`,
                    // ...otros headers necesarios que puedas extraer de tus hallazgos
                },
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                throw new Error(`La petición a la API falló con estado: ${response.status}`);
            }

            // 3. Leer la respuesta en stream (SSE)
            const reader = response.body.getReader();
            const decoder = new TextDecoder();

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                const chunk = decoder.decode(value);
                // Llamamos a la función de Node.js que expusimos antes
                window.onDataReceived(chunk);
            }

            return { success: true };

        }, { modelId, messages });
        
        // Cuando el stream del navegador termina, cerramos nuestra respuesta
        res.end();

    } catch (error) {
        console.error('Error durante la evaluación en la página:', error);
        if (!res.headersSent) {
            res.status(500).json({ error: error.message });
        } else {
            res.end(); // Asegurarse de cerrar la conexión si ya se enviaron headers
        }
    }
});


// Iniciar todo
startBrowser().then(() => {
    app.listen(PORT, () => {
        console.log(`Servidor headless worker escuchando en el puerto ${PORT}`);
    });
}).catch(err => {
    console.error('No se pudo iniciar el navegador:', err);
    process.exit(1);
});