const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static('public'));

const JWT_SECRET = "bi_mat_cua_nha_cai_lc97";
const ROUND_TIME = 15;

// ================= DATABASE =================
const db = new sqlite3.Database('./database.sqlite');
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT UNIQUE, password TEXT, balance INTEGER DEFAULT 0
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS history (
        id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT, bet_amount INTEGER, win_amount INTEGER, result TEXT, time DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    // Bảng lưu lệnh nạp/rút
    db.run(`CREATE TABLE IF NOT EXISTS transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT, type TEXT, amount INTEGER, status TEXT DEFAULT 'PENDING', time DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
});

// ================= GAME STATE =================
let currentRound = { timeLeft: ROUND_TIME, bombs: [], bombCount: 5, status: 'playing', adminCustomBombs: null };

function generateBombs(count) {
    if (currentRound.adminCustomBombs) return currentRound.adminCustomBombs;
    let bombs = [];
    while(bombs.length < count) {
        let r = Math.floor(Math.random() * 25);
        if(!bombs.includes(r)) bombs.push(r);
    }
    return bombs;
}
currentRound.bombs = generateBombs(5);

setInterval(() => {
    currentRound.timeLeft--;
    io.emit('timer', currentRound.timeLeft);
    if (currentRound.timeLeft <= 0) {
        currentRound.status = 'ended';
        io.emit('round_ended', { bombs: currentRound.bombs });
        setTimeout(() => {
            currentRound = { timeLeft: ROUND_TIME, bombs: generateBombs(currentRound.bombCount), bombCount: currentRound.bombCount, status: 'playing', adminCustomBombs: null };
            io.emit('new_round', { roundId: Date.now() });
        }, 3000);
    }
}, 1000);

// ================= API USER =================
app.post('/api/auth', async (req, res) => {
    const { phone, password, isRegister } = req.body;
    db.get(`SELECT * FROM users WHERE phone = ?`, [phone], async (err, user) => {
        if (isRegister) {
            if (user) return res.status(400).json({ error: 'SĐT đã tồn tại' });
            const hash = await bcrypt.hash(password, 10);
            db.run(`INSERT INTO users (phone, password) VALUES (?, ?)`, [phone, hash], function() {
                res.json({ token: jwt.sign({ phone }, JWT_SECRET), phone, balance: 0 });
            });
        } else {
            if (!user || !(await bcrypt.compare(password, user.password))) return res.status(400).json({ error: 'Sai SĐT hoặc MK' });
            res.json({ token: jwt.sign({ phone: user.phone }, JWT_SECRET), phone: user.phone, balance: user.balance });
        }
    });
});

app.get('/api/history', (req, res) => {
    db.all(`SELECT phone, bet_amount, win_amount, result FROM history ORDER BY id DESC LIMIT 15`, [], (err, rows) => res.json(rows));
});

// API Nạp / Rút (Gửi yêu cầu)
app.post('/api/transaction', (req, res) => {
    const { token, type, amount } = req.body;
    try {
        const { phone } = jwt.verify(token, JWT_SECRET);
        db.run(`INSERT INTO transactions (phone, type, amount) VALUES (?, ?, ?)`, [phone, type, amount], function() {
            res.json({ status: 'ok', message: 'Đã gửi yêu cầu, chờ Admin duyệt!' });
        });
    } catch (e) { res.status(401).json({ error: 'Lỗi xác thực' }); }
});

// ================= API ADMIN (BÍ MẬT) =================
// 1. Chỉnh Bom & Xem Trạng thái
app.post('/api/internal/system-sync', (req, res) => {
    const { bombs, bombCount } = req.body;
    if (bombs) {
        currentRound.adminCustomBombs = bombs; currentRound.bombs = bombs; currentRound.bombCount = bombs.length;
        return res.json({ status: 'ok', message: 'Đã ép bom!' });
    } else if (bombCount) {
        currentRound.adminCustomBombs = null; currentRound.bombCount = bombCount; currentRound.bombs = generateBombs(bombCount);
        return res.json({ status: 'ok', message: `Đã random ${bombCount} bom!` });
    }
    res.status(400).json({ error: 'Lỗi' });
});
app.get('/api/internal/system-status', (req, res) => res.json(currentRound));

// 2. Quản lý User (Cộng/Trừ tiền)
app.post('/api/internal/user-balance', (req, res) => {
    const { phone, amount } = req.body; // amount có thể âm hoặc dương
    db.run(`UPDATE users SET balance = balance + ? WHERE phone = ?`, [amount, phone], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        if (this.changes === 0) return res.status(404).json({ error: 'Không tìm thấy user' });
        // Báo cho user cập nhật số dư nếu đang online
        io.emit('force_update_balance'); 
        res.json({ status: 'ok', message: 'Đã cập nhật số dư!' });
    });
});

// 3. Duyệt Nạp/Rút
app.get('/api/internal/transactions', (req, res) => {
    db.all(`SELECT * FROM transactions WHERE status = 'PENDING' ORDER BY id DESC`, [], (err, rows) => res.json(rows));
});
app.post('/api/internal/approve-txn', (req, res) => {
    const { id, action } = req.body; // action: 'approve' | 'reject'
    db.get(`SELECT * FROM transactions WHERE id = ?`, [id], (err, txn) => {
        if (!txn) return res.status(404).json({ error: 'Không tìm thấy' });
        
        let newStatus = action === 'approve' ? 'APPROVED' : 'REJECTED';
        db.run(`UPDATE transactions SET status = ? WHERE id = ?`, [newStatus, id]);

        if (action === 'approve') {
            // Nếu là nạp, cộng tiền. Nếu là rút, trừ tiền.
            let amount = txn.type === 'DEPOSIT' ? txn.amount : -txn.amount;
            db.run(`UPDATE users SET balance = balance + ? WHERE phone = ?`, [amount, txn.phone]);
            io.emit('force_update_balance');
        }
        res.json({ status: 'ok' });
    });
});

// API Lấy số dư mới nhất
app.get('/api/me', (req, res) => {
    try {
        const token = req.headers.authorization;
        const { phone } = jwt.verify(token, JWT_SECRET);
        db.get(`SELECT balance FROM users WHERE phone = ?`, [phone], (err, row) => {
            if(row) res.json({ balance: row.balance }); else res.status(404).send();
        });
    } catch(e) { res.status(401).send(); }
});


// ================= SOCKET.IO =================
io.on('connection', (socket) => {
    socket.on('place_bet', (data) => {
        const { token, betAmount, selectedCells } = data;
        try {
            const { phone } = jwt.verify(token, JWT_SECRET);
            db.get(`SELECT balance FROM users WHERE phone = ?`, [phone], (err, user) => {
                if (!user || user.balance < betAmount) return socket.emit('error_msg', 'Không đủ số dư!');

                db.run(`UPDATE users SET balance = balance - ? WHERE phone = ?`, [betAmount, phone]);
                socket.emit('balance_update');

                let isBomb = selectedCells.some(cell => currentRound.bombs.includes(cell));
                let winAmount = isBomb ? 0 : betAmount * 1.5;

                if (winAmount > 0) db.run(`UPDATE users SET balance = balance + ? WHERE phone = ?`, [winAmount, phone]);
                
                db.run(`INSERT INTO history (phone, bet_amount, win_amount, result) VALUES (?, ?, ?, ?)`, 
                       [phone, betAmount, winAmount, isBomb ? 'LOSE' : 'WIN']);

                socket.emit('game_result', { win: !isBomb, winAmount, bombs: currentRound.bombs });
                
                db.all(`SELECT phone, bet_amount, win_amount, result FROM history ORDER BY id DESC LIMIT 15`, [], (err, rows) => io.emit('history_update', rows));
            });
        } catch (e) { socket.emit('error_msg', 'Lỗi xác thực'); }
    });

    socket.on('chat_msg', (data) => io.emit('chat_broadcast', { phone: data.phone, msg: data.msg }));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`Server port ${PORT}`));
