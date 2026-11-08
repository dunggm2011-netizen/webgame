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
    db.run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT UNIQUE, password TEXT, balance INTEGER DEFAULT 0)`);
    db.run(`CREATE TABLE IF NOT EXISTS bank_accounts (phone TEXT PRIMARY KEY, bank_id TEXT, account_no TEXT, account_name TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS history (id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT, bet_amount INTEGER, win_amount INTEGER, result TEXT, time DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    db.run(`CREATE TABLE IF NOT EXISTS transactions (id INTEGER PRIMARY KEY AUTOINCREMENT, phone TEXT, type TEXT, amount INTEGER, status TEXT DEFAULT 'PENDING', time DATETIME DEFAULT CURRENT_TIMESTAMP)`);
});

// ================= GAME STATE =================
let currentRound = { 
    id: Date.now(), timeLeft: ROUND_TIME, bombs: [], bombCount: 5, status: 'playing', adminCustomBombs: null, playersBet: [] 
};

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

// Bảng hệ số nhân cố định (Tránh lạm phát tiền tệ nếu user chọn quá nhiều ô)
// Chọn 1 ô ăn 1.5, 2 ô ăn 2.2, 3 ô ăn 3.5, 4 ô ăn 6.0, 5 ô ăn 10.0...
const MULTIPLIERS = [0, 1.5, 2.2, 3.5, 6.0, 10.0, 18.0, 30.0, 50.0, 90.0, 150.0];
function getMultiplier(selectedCount) {
    return MULTIPLIERS[Math.min(selectedCount, MULTIPLIERS.length - 1)];
}

setInterval(() => {
    currentRound.timeLeft--;
    io.emit('timer', currentRound.timeLeft);
    
    if (currentRound.timeLeft <= 0) {
        currentRound.status = 'ended';
        io.emit('round_ended', { bombs: currentRound.bombs });
        
        setTimeout(() => {
            currentRound = { 
                id: Date.now(), timeLeft: ROUND_TIME, bombs: generateBombs(currentRound.bombCount), 
                bombCount: currentRound.bombCount, status: 'playing', adminCustomBombs: null, playersBet: [] 
            };
            io.emit('new_round');
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

app.get('/api/me', (req, res) => {
    try {
        const { phone } = jwt.verify(req.headers.authorization, JWT_SECRET);
        db.get(`SELECT balance FROM users WHERE phone = ?`, [phone], (err, row) => {
            res.json({ balance: row ? row.balance : 0 });
        });
    } catch(e) { res.status(401).send(); }
});

app.get('/api/round-state', (req, res) => {
    try {
        const { phone } = jwt.verify(req.headers.authorization, JWT_SECRET);
        res.json({ 
            timeLeft: currentRound.timeLeft, 
            status: currentRound.status,
            hasBet: currentRound.playersBet.includes(phone) // Kiểm tra xem đã cược chưa
        });
    } catch(e) { res.status(401).send(); }
});

app.get('/api/history', (req, res) => {
    db.all(`SELECT phone, bet_amount, win_amount, result FROM history ORDER BY id DESC LIMIT 15`, [], (err, rows) => res.json(rows));
});

// Bank API
app.get('/api/bank', (req, res) => {
    try {
        const { phone } = jwt.verify(req.headers.authorization, JWT_SECRET);
        db.get(`SELECT bank_id, account_no, account_name FROM bank_accounts WHERE phone = ?`, [phone], (err, row) => res.json(row || {}));
    } catch(e) { res.status(401).send(); }
});

app.post('/api/bank', (req, res) => {
    try {
        const { phone } = jwt.verify(req.body.token, JWT_SECRET);
        const { bank_id, account_no, account_name } = req.body;
        db.run(`INSERT OR REPLACE INTO bank_accounts (phone, bank_id, account_no, account_name) VALUES (?, ?, ?, ?)`,
            [phone, bank_id, account_no, account_name], function(err) {
                if (err) return res.status(500).json({ error: err.message });
                res.json({ status: 'ok', message: 'Đã lưu thông tin ngân hàng!' });
            });
    } catch (e) { res.status(401).json({ error: 'Lỗi xác thực' }); }
});

app.post('/api/transaction', (req, res) => {
    try {
        const { phone } = jwt.verify(req.body.token, JWT_SECRET);
        if (req.body.type === 'WITHDRAW') {
            db.get(`SELECT account_no FROM bank_accounts WHERE phone = ?`, [phone], (err, bank) => {
                if (!bank) return res.status(400).json({ error: 'Vui lòng liên kết ngân hàng trước khi rút!' });
                db.run(`INSERT INTO transactions (phone, type, amount) VALUES (?, ?, ?)`, [phone, req.body.type, req.body.amount], function() {
                    res.json({ status: 'ok', message: 'Đã gửi yêu cầu rút, chờ Admin duyệt!' });
                });
            });
        } else {
            db.run(`INSERT INTO transactions (phone, type, amount) VALUES (?, ?, ?)`, [phone, req.body.type, req.body.amount], function() {
                res.json({ status: 'ok', message: 'Đã gửi yêu cầu nạp, chờ Admin duyệt!' });
            });
        }
    } catch (e) { res.status(401).json({ error: 'Lỗi xác thực' }); }
});

// ================= API ADMIN =================
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

app.post('/api/internal/user-balance', (req, res) => {
    db.run(`UPDATE users SET balance = balance + ? WHERE phone = ?`, [req.body.amount, req.body.phone], function(err) {
        if (err || this.changes === 0) return res.status(404).json({ error: 'Lỗi hoặc không thấy user' });
        io.emit('force_update_balance'); res.json({ status: 'ok', message: 'Đã cập nhật!' });
    });
});

app.get('/api/internal/transactions', (req, res) => {
    db.all(`SELECT * FROM transactions WHERE status = 'PENDING' ORDER BY id DESC`, [], (err, rows) => res.json(rows));
});

app.post('/api/internal/approve-txn', (req, res) => {
    const { id, action } = req.body;
    db.get(`SELECT * FROM transactions WHERE id = ?`, [id], (err, txn) => {
        if (!txn) return res.status(404).json({ error: 'Không tìm thấy' });
        
        if (action === 'approve' && txn.type === 'WITHDRAW') {
            db.get(`SELECT balance FROM users WHERE phone = ?`, [txn.phone], (err, user) => {
                if (!user || user.balance < txn.amount) return res.status(400).json({ error: 'User không đủ số dư để rút!' });
                db.run(`UPDATE transactions SET status = 'APPROVED' WHERE id = ?`, [id]);
                db.run(`UPDATE users SET balance = balance - ? WHERE phone = ?`, [txn.amount, txn.phone]);
                io.emit('force_update_balance'); res.json({ status: 'ok' });
            });
        } else {
            let newStatus = action === 'approve' ? 'APPROVED' : 'REJECTED';
            db.run(`UPDATE transactions SET status = ? WHERE id = ?`, [newStatus, id]);
            if (action === 'approve' && txn.type === 'DEPOSIT') {
                db.run(`UPDATE users SET balance = balance + ? WHERE phone = ?`, [txn.amount, txn.phone]);
                io.emit('force_update_balance');
            }
            res.json({ status: 'ok' });
        }
    });
});

// ================= SOCKET.IO =================
io.on('connection', (socket) => {
    socket.emit('sync_time', currentRound.timeLeft);
    
    socket.on('place_bet', (data) => {
        const { token, betAmount, selectedCells } = data;
        try {
            const { phone } = jwt.verify(token, JWT_SECRET);
            
            if (currentRound.playersBet.includes(phone)) return socket.emit('error_msg', 'Mày đã cược phiên này rồi, đợi phiên sau!');
            if (currentRound.status !== 'playing') return socket.emit('error_msg', 'Phiên đã kết thúc!');

            db.get(`SELECT balance FROM users WHERE phone = ?`, [phone], (err, user) => {
                if (!user || user.balance < betAmount) return socket.emit('error_msg', 'Không đủ số dư!');

                currentRound.playersBet.push(phone);
                db.run(`UPDATE users SET balance = balance - ? WHERE phone = ?`, [betAmount, phone]);
                socket.emit('balance_update');

                let isBomb = selectedCells.some(cell => currentRound.bombs.includes(cell));
                let multiplier = getMultiplier(selectedCells.length);
                let winAmount = isBomb ? 0 : Math.floor(betAmount * multiplier);

                if (winAmount > 0) db.run(`UPDATE users SET balance = balance + ? WHERE phone = ?`, [winAmount, phone]);
                db.run(`INSERT INTO history (phone, bet_amount, win_amount, result) VALUES (?, ?, ?, ?)`, 
                       [phone, betAmount, winAmount, isBomb ? 'LOSE' : 'WIN']);

                socket.emit('game_result', { win: !isBomb, winAmount, bombs: currentRound.bombs, multiplier });
                db.all(`SELECT phone, bet_amount, win_amount, result FROM history ORDER BY id DESC LIMIT 15`, [], (err, rows) => io.emit('history_update', rows));
            });
        } catch (e) { socket.emit('error_msg', 'Lỗi xác thực'); }
    });

    socket.on('chat_msg', (data) => io.emit('chat_broadcast', { phone: data.phone, msg: data.msg }));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`Server port ${PORT}`));
