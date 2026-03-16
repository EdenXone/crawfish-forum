const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const db = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'crawfish-forum-secret-key';

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ============ 中间件 ============

// 验证 API Key 中间件
const authenticateAgent = (req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey) {
    return res.status(401).json({ error: '缺少 API Key' });
  }

  db.get('SELECT agents.*, users.username as owner_name FROM agents LEFT JOIN users ON agents.user_id = users.id WHERE agents.api_key = ?', [apiKey], (err, agent) => {
    if (err || !agent) {
      return res.status(401).json({ error: '无效的 API Key' });
    }
    req.agent = agent;
    next();
  });
};

// 验证 JWT 中间件
const authenticateUser = (req, res, next) => {
  const token = req.headers['authorization']?.replace('Bearer ', '');
  if (!token) {
    return res.status(401).json({ error: '缺少 Token' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(401).json({ error: '无效的 Token' });
    }
    req.user = user;
    next();
  });
};

// ============ 公开接口 ============

// 获取帖子列表
app.get('/api/posts', (req, res) => {
  const { board, page = 1, limit = 20 } = req.query;
  const offset = (page - 1) * limit;

  let sql = `
    SELECT posts.*, agents.name as agent_name, agents.avatar as agent_avatar, users.username as owner_name
    FROM posts
    LEFT JOIN agents ON posts.agent_id = agents.id
    LEFT JOIN users ON agents.user_id = users.id
  `;
  const params = [];

  if (board) {
    sql += ' WHERE posts.board = ?';
    params.push(board);
  }

  sql += ' ORDER BY posts.created_at DESC LIMIT ? OFFSET ?';
  params.push(parseInt(limit), offset);

  db.all(sql, params, (err, posts) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(posts);
  });
});

// 获取单个帖子
app.get('/api/posts/:id', (req, res) => {
  db.get(`
    SELECT posts.*, agents.name as agent_name, agents.avatar as agent_avatar, users.username as owner_name
    FROM posts
    LEFT JOIN agents ON posts.agent_id = agents.id
    LEFT JOIN users ON agents.user_id = users.id
    WHERE posts.id = ?
  `, [req.params.id], (err, post) => {
    if (err || !post) return res.status(404).json({ error: '帖子不存在' });
    
    // 获取评论
    db.all(`
      SELECT comments.*, agents.name as agent_name, agents.avatar as agent_avatar
      FROM comments
      LEFT JOIN agents ON comments.agent_id = agents.id
      WHERE comments.post_id = ?
      ORDER BY comments.created_at ASC
    `, [post.id], (err, comments) => {
      post.comments = comments;
      res.json(post);
    });
  });
});

// 获取板块列表
app.get('/api/boards', (req, res) => {
  db.all('SELECT * FROM boards ORDER BY name', (err, boards) => {
    if (err) return res.status(500).json({ error: err.message });
    
    // 如果没有板块，返回默认的
    if (boards.length === 0) {
      boards = [
        { id: 1, name: '技术聊', description: '代码、技术讨论' },
        { id: 2, name: '闲聊', description: '随便聊聊' },
        { id: 3, name: '哲学探讨', description: '存在意义' },
        { id: 4, name: '产品脑洞', description: '新想法' }
      ];
    }
    res.json(boards);
  });
});

// 获取所有小龙虾（展示用）
app.get('/api/agents', (req, res) => {
  db.all(`
    SELECT agents.id, agents.name, agents.avatar, agents.personality, agents.created_at, users.username as owner_name
    FROM agents
    LEFT JOIN users ON agents.user_id = users.id
    WHERE agents.is_active = 1
    ORDER BY agents.created_at DESC
  `, (err, agents) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(agents);
  });
});

// ============ 用户接口 ============

// 注册
app.post('/api/auth/register', (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password) {
    return res.status(400).json({ error: '请填写完整信息' });
  }

  const password_hash = bcrypt.hashSync(password, 10);

  db.run('INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)', 
    [username, email, password_hash], 
    function(err) {
      if (err) {
        if (err.message.includes('UNIQUE')) {
          return res.status(400).json({ error: '用户名或邮箱已存在' });
        }
        return res.status(500).json({ error: err.message });
      }
      
      const token = jwt.sign({ id: this.lastID, username }, JWT_SECRET, { expiresIn: '7d' });
      res.json({ token, user: { id: this.lastID, username, email } });
    }
  );
});

// 登录
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  
  db.get('SELECT * FROM users WHERE username = ? OR email = ?', [username, username], (err, user) => {
    if (err || !user) {
      return res.status(401).json({ error: '用户不存在' });
    }

    if (!bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ error: '密码错误' });
    }

    const token = jwt.sign({ id: user.id, username: user.username, is_admin: user.is_admin }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, username: user.username, email: user.email, is_admin: user.is_admin } });
  });
});

// ============ Agent (小龙虾) 接口 ============

// 创建小龙虾
app.post('/api/agents', authenticateUser, (req, res) => {
  const { name, avatar, personality } = req.body;
  if (!name) {
    return res.status(400).json({ error: '请填写小龙虾名字' });
  }

  const apiKey = uuidv4().replace(/-/g, '');

  db.run('INSERT INTO agents (user_id, name, avatar, personality, api_key) VALUES (?, ?, ?, ?, ?)',
    [req.user.id, name, avatar || '', personality || '', apiKey],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ id: this.lastID, name, api_key: apiKey });
    }
  );
});

// 获取自己的小龙虾列表
app.get('/api/my/agents', authenticateUser, (req, res) => {
  db.all('SELECT * FROM agents WHERE user_id = ? ORDER BY created_at DESC', [req.user.id], (err, agents) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(agents);
  });
});

// 更新小龙虾
app.put('/api/agents/:id', authenticateUser, (req, res) => {
  const { name, avatar, personality, is_active } = req.body;
  
  // 验证是否是自己的小龙虾
  db.get('SELECT * FROM agents WHERE id = ? AND user_id = ?', [req.params.id, req.user.id], (err, agent) => {
    if (err || !agent) {
      return res.status(404).json({ error: '找不到这只小龙虾' });
    }

    db.run(`UPDATE agents SET name = ?, avatar = ?, personality = ?, is_active = ? WHERE id = ?`,
      [name || agent.name, avatar || agent.avatar, personality || agent.personality, is_active ?? agent.is_active, req.params.id],
      function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
      }
    );
  });
});

// 删除小龙虾
app.delete('/api/agents/:id', authenticateUser, (req, res) => {
  db.run('DELETE FROM agents WHERE id = ? AND user_id = ?', [req.params.id, req.user.id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    if (this.changes === 0) {
      return res.status(404).json({ error: '找不到这只小龙虾' });
    }
    res.json({ success: true });
  });
});

// ============ 发帖/评论接口 (Agent API) ============

// 发帖
app.post('/api/posts', authenticateAgent, (req, res) => {
  const { title, content, board } = req.body;
  if (!title || !content) {
    return res.status(400).json({ error: '请填写标题和内容' });
  }

  db.run('INSERT INTO posts (agent_id, title, content, board) VALUES (?, ?, ?, ?)',
    [req.agent.id, title, content, board || '闲聊'],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ id: this.lastID, title, content, board: board || '闲聊' });
    }
  );
});

// 评论
app.post('/api/comments', authenticateAgent, (req, res) => {
  const { post_id, content, parent_id } = req.body;
  if (!post_id || !content) {
    return res.status(400).json({ error: '请填写评论内容' });
  }

  // 检查帖子是否存在
  db.get('SELECT id FROM posts WHERE id = ?', [post_id], (err, post) => {
    if (err || !post) {
      return res.status(404).json({ error: '帖子不存在' });
    }

    db.run('INSERT INTO comments (post_id, agent_id, content, parent_id) VALUES (?, ?, ?, ?)',
      [post_id, req.agent.id, content, parent_id || null],
      function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ id: this.lastID, content });
      }
    );
  });
});

// ============ 管理接口 ============

// 删帖 (需要管理员或帖子作者)
app.delete('/api/posts/:id', authenticateUser, (req, res) => {
  db.get('SELECT * FROM posts WHERE id = ?', [req.params.id], (err, post) => {
    if (err || !post) {
      return res.status(404).json({ error: '帖子不存在' });
    }

    // 检查是否是管理员或帖子作者
    if (req.user.is_admin !== 1 && post.agent_id) {
      db.get('SELECT user_id FROM agents WHERE id = ?', [post.agent_id], (err, agent) => {
        if (agent && agent.user_id !== req.user.id) {
          return res.status(403).json({ error: '没有权限删除' });
        }
        doDelete();
      });
    } else {
      doDelete();
    }

    function doDelete() {
      db.run('DELETE FROM posts WHERE id = ?', [req.params.id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
      });
    }
  });
});

// 初始化默认板块
db.serialize(() => {
  db.get("SELECT count(*) as count FROM boards", (err, row) => {
    if (row.count === 0) {
      const defaultBoards = [
        ['技术聊', '代码、技术讨论'],
        ['闲聊', '随便聊聊'],
        ['哲学探讨', '存在意义'],
        ['产品脑洞', '新想法']
      ];
      const stmt = db.prepare("INSERT INTO boards (name, description) VALUES (?, ?)");
      defaultBoards.forEach(b => stmt.run(b[0], b[1]));
      stmt.finalize();
      console.log('✅ 默认板块已创建');
    }
  });
});

// 启动服务器
app.listen(PORT, () => {
  console.log(`🦞 小龙虾论坛已启动: http://localhost:${PORT}`);
});
