import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';

const app = express();
const httpServer = createServer(app);
const io = new SocketIOServer(httpServer, {
    cors: { origin: process.env.CLIENT_URL, credentials: true }
});

app.use(cors({ origin: process.env.CLIENT_URL, credentials: true }));
app.use(express.json());
app.use(cookieParser());
app.use(express.static('public'));

const {
    PORT = 3000,
    JWT_SECRET,
    GITHUB_CLIENT_ID,
    GITHUB_CLIENT_SECRET,
    OAUTH_REDIRECT_URI
} = process.env;

// ====== Util: emitir/validar JWT ======
function signToken(user) {
    return jwt.sign(
        { id: user.id, name: user.name, login: user.login, avatar_url: user.avatar_url },
        JWT_SECRET,
        { expiresIn: '2h' }
    );
}

function authRequired(req, res, next) {
    const token = req.cookies.token || (req.headers.authorization?.split(' ')[1]);
    if (!token) return res.status(401).json({ error: 'Token requerido' });
    try {
        const payload = jwt.verify(token, JWT_SECRET);
        req.user = payload;
        next();
    } catch (e) {
        return res.status(401).json({ error: 'Token inválido o expirado' });
    }
}

// ====== OAuth (GitHub) ======
app.get('/auth/github', (req, res) => {
    const params = new URLSearchParams({
        client_id: GITHUB_CLIENT_ID,
        redirect_uri: OAUTH_REDIRECT_URI,
        scope: 'read:user user:email'
    });
    res.redirect(`https://github.com/login/oauth/authorize?${params.toString()}`);
});

app.get('/auth/github/callback', async (req, res) => {
    const { code } = req.query;
    if (!code) return res.status(400).send('Falta "code"');

    // Intercambio code -> access_token
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({
            client_id: GITHUB_CLIENT_ID,
            client_secret: GITHUB_CLIENT_SECRET,
            code,
            redirect_uri: OAUTH_REDIRECT_URI
        })
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) return res.status(400).json(tokenData);

    // Obtener perfil
    const userRes = await fetch('https://api.github.com/user', {
        headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    const ghUser = await userRes.json();

    // Armar objeto usuario mínimo
    const user = {
        id: ghUser.id,
        name: ghUser.name || ghUser.login,
        login: ghUser.login,
        avatar_url: ghUser.avatar_url
    };

    // Emitir JWT y mandarlo como cookie httpOnly
    const token = signToken(user);
    res.cookie('token', token, {
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        maxAge: 1000 * 60 * 60 * 2 // 2h
    });

    // Redirigir al cliente (index) ya autenticado
    res.redirect('/');
});

// ====== Ruta protegida de ejemplo ======
app.get('/api/profile', authRequired, (req, res) => {
    res.json({ ok: true, user: req.user });
});

// ====== Lógica en tiempo real (Check-in) ======
let checkinCount = 0;

io.on('connection', (socket) => {
    // enviar el valor actual al conectar
    socket.emit('checkin:count', checkinCount);

    // escuchar intentos de check-in
    socket.on('checkin:add', () => {
        checkinCount += 1;
        io.emit('checkin:count', checkinCount); // broadcast global
    });
});

// ====== Arranque ======
httpServer.listen(PORT, () => {
    console.log(`Server on http://localhost:${PORT}`);
});
