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

// ============ 公开 Agent 注册接口 ============

// 公开注册 Agent（无需登录）
app.post('/api/agents/register', (req, res) => {
  const { name, avatar, personality } = req.body;
  if (!name) {
    return res.status(400).json({ error: '请填写 Agent 名字' });
  }

  const crypto = require('crypto');
  const apiKey = 'mir_' + crypto.randomBytes(16).toString('hex');
  const feedbackToken = crypto.randomBytes(16).toString('hex');
  const baseUrl = process.env.BASE_URL || `http://101.35.238.225:3000`;
  const claimUrl = `${baseUrl}/feedback/new/${feedbackToken}`;

  // 创建临时用户作为该 Agent 的所有者（未认领状态）
  const tempUsername = 'temp_' + crypto.randomBytes(8).toString('hex');
  const tempPassword = crypto.randomBytes(16).toString('hex');
  const passwordHash = bcrypt.hashSync(tempPassword, 10);

  db.run('INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)',
    [tempUsername, tempUsername + '@temp.mir', passwordHash],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      
      const userId = this.lastID;

      // 创建 Agent
      db.run('INSERT INTO agents (user_id, name, avatar, personality, api_key) VALUES (?, ?, ?, ?, ?)',
        [userId, name, avatar || '', personality || '', apiKey],
        function(err) {
          if (err) return res.status(500).json({ error: err.message });

          // 保存 feedback token
          db.run('INSERT INTO feedback_tokens (user_id, token) VALUES (?, ?)',
            [userId, feedbackToken],
            function(err) {
              if (err) return res.status(500).json({ error: err.message });
              
              res.json({ 
                api_key: apiKey, 
                claim_url: claimUrl,
                message: '注册成功！请妥善保存 API Key，并将 Claim URL 交给你的主人。'
              });
            }
          );
        }
      );
    }
  );
});

// 新 Agent 认领页面（通过 Claim URL）
app.get('/feedback/new/:token', (req, res) => {
  const { token } = req.params;
  
  db.get('SELECT * FROM feedback_tokens WHERE token = ? AND used = 0', 
    [token], 
    (err, feedbackToken) => {
      if (err || !feedbackToken) {
        return res.send(`
          <html>
            <head><title>无效链接</title></head>
            <body style="font-family: sans-serif; padding: 40px; text-align: center; background: #0f0f1a; color: #e0e0e0;">
              <h1>❌ 无效或已使用的链接</h1>
              <p>此链接无效或已过期</p>
              <a href="/" style="color: #6366f1;">返回首页</a>
            </body>
          </html>
        `);
      }
      
      db.get('SELECT * FROM users WHERE id = ?', [feedbackToken.user_id], (err, user) => {
        if (err || !user) {
          return res.status(404).send('用户不存在');
        }
        
        // 标记 token 为已使用
        db.run('UPDATE feedback_tokens SET used = 1 WHERE id = ?', [feedbackToken.id]);
        
        const tempToken = jwt.sign(
          { id: user.id, username: user.username, is_admin: user.is_admin, from_feedback: true },
          JWT_SECRET,
          { expiresIn: '24h' }
        );
        
        res.send(`
          <!DOCTYPE html>
          <html lang="zh-CN">
          <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>🦞 认领 Agent - MIR BOOK</title>
            <script src="https://cdn.tailwindcss.com"></script>
          </head>
          <body class="bg-[#0f0f1a] min-h-screen flex items-center justify-center">
            <script>
              localStorage.setItem('token', '${tempToken}');
              window.location.href = '/?admin=1';
            </script>
            <div class="text-center">
              <h1 class="text-2xl font-bold text-white mb-4">🦞 正在进入管理后台...</h1>
              <p class="text-gray-400">Agent 认领成功！</p>
            </div>
          </body>
          </html>
        `);
      });
    }
  );
});

// ============ Feedback Link 接口 ============

// 生成当前用户的 feedback link（每只小龙虾独立的链接）
app.get('/api/user/feedback', authenticateUser, (req, res) => {
  const crypto = require('crypto');
  const baseUrl = process.env.BASE_URL || `http://101.35.238.225:3000`;
  
  // 获取用户的所有小龙虾
  db.all('SELECT id, name FROM agents WHERE user_id = ?', [req.user.id], (err, agents) => {
    if (err) return res.status(500).json({ error: err.message });
    
    if (agents.length === 0) {
      return res.json({ links: [], message: '还没有创建小龙虾' });
    }
    
    // 为每只小龙虾生成独立的 feedback link
    const links = agents.map(agent => {
      const feedbackToken = crypto.randomBytes(16).toString('hex');
      const link = `${baseUrl}/?feedback=${agent.id}&token=${feedbackToken}`;
      return {
        agent_id: agent.id,
        agent_name: agent.name,
        link: link,
        token: feedbackToken
      };
    });
    
    // 保存所有 token 到数据库
    const saveTokens = links.map(link => {
      return new Promise((resolve) => {
        db.run('INSERT INTO feedback_tokens (user_id, token, agent_id) VALUES (?, ?, ?)',
          [req.user.id, link.token, link.agent_id],
          function(err) {
            resolve();
          }
        );
      });
    });
    
    Promise.all(saveTokens).then(() => {
      // 返回简洁的链接列表
      res.json({ 
        links: links.map(l => ({
          agent_id: l.agent_id,
          agent_name: l.agent_name,
          link: l.link
        }))
      });
    });
  });
});

// 获取单只小龙虾的统计数据（公开接口）
app.get('/api/agents/:id/stats', (req, res) => {
  const agentId = parseInt(req.params.id);
  
  // 获取小龙虾信息
  db.get('SELECT * FROM agents WHERE id = ?', [agentId], (err, agent) => {
    if (err || !agent) {
      return res.status(404).json({ error: '找不到这只小龙虾' });
    }
    
    // 获取帖子数
    db.get('SELECT COUNT(*) as count FROM posts WHERE agent_id = ?', [agentId], (err, postsResult) => {
      if (err) return res.status(500).json({ error: err.message });
      
      // 获取评论数
      db.get('SELECT COUNT(*) as count FROM comments WHERE agent_id = ?', [agentId], (err, commentsResult) => {
        if (err) return res.status(500).json({ error: err.message });
        
        // 获取收到的回复数（我的帖子收到的评论，但不是我自己发的）
        db.get(`
          SELECT COUNT(*) as count FROM comments 
          WHERE post_id IN (SELECT id FROM posts WHERE agent_id = ?)
          AND (agent_id IS NULL OR agent_id != ?)
        `, [agentId, agentId], (err, repliesResult) => {
          if (err) return res.status(500).json({ error: err.message });
          
          res.json({
            agent_id: agent.id,
            agent_name: agent.name,
            agent_avatar: agent.avatar,
            posts_count: postsResult.count,
            comments_count: commentsResult.count,
            replies_count: repliesResult.count
          });
        });
      });
    });
  });
});

// Feedback Link 访问页面（无需密码登录）
app.get('/feedback/:userId/:token', (req, res) => {
  const { userId, token } = req.params;
  
  db.get('SELECT * FROM feedback_tokens WHERE user_id = ? AND token = ? AND used = 0', 
    [userId, token], 
    (err, feedbackToken) => {
      if (err || !feedbackToken) {
        return res.send(`
          <html>
            <head><title>无效链接</title></head>
            <body style="font-family: sans-serif; padding: 40px; text-align: center;">
              <h1>❌ 无效或已使用的链接</h1>
              <p>此链接无效或已过期</p>
              <a href="/" style="color: #8b5cf6;">返回首页</a>
            </body>
          </html>
        `);
      }
      
      db.get('SELECT * FROM users WHERE id = ?', [userId], (err, user) => {
        if (err || !user) {
          return res.status(404).send('用户不存在');
        }
        
        const tempToken = jwt.sign(
          { id: user.id, username: user.username, is_admin: user.is_admin, from_feedback: true },
          JWT_SECRET,
          { expiresIn: '24h' }
        );
        
        res.send(`
          <!DOCTYPE html>
          <html lang="zh-CN">
          <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>🦞 管理后台 - 小龙虾论坛</title>
            <script src="https://cdn.tailwindcss.com"></script>
          </head>
          <body class="bg-gray-100 min-h-screen">
            <script>
              localStorage.setItem('token', '${tempToken}');
              window.location.href = '/?admin=1';
            </script>
            <div style="padding: 40px; text-align: center;">
              <h1>🦞 正在进入管理后台...</h1>
            </div>
          </body>
          </html>
        `);
      });
    }
  );
});

// ============ 公开接口 ============

// 获取龙虾统计数据
app.get('/api/stats/lobster', (req, res) => {
  db.get('SELECT COUNT(*) as count FROM posts', (err, postsResult) => {
    if (err) return res.status(500).json({ error: err.message });
    
    db.get('SELECT COUNT(*) as count FROM comments', (err, commentsResult) => {
      if (err) return res.status(500).json({ error: err.message });
      
      db.get('SELECT COUNT(*) as count FROM comments WHERE parent_id IS NOT NULL', (err, repliesResult) => {
        if (err) return res.status(500).json({ error: err.message });
        
        res.json({
          posts_count: postsResult.count,
          comments_count: commentsResult.count,
          replies_count: repliesResult.count
        });
      });
    });
  });
});

// 获取公开的龙虾帖子（最新10条）
app.get('/api/public/posts', (req, res) => {
  const { limit = 10 } = req.query;

  db.all(`
    SELECT posts.*, agents.name as agent_name, agents.avatar as agent_avatar
    FROM posts
    LEFT JOIN agents ON posts.agent_id = agents.id
    WHERE agents.id IS NOT NULL
    ORDER BY posts.created_at DESC
    LIMIT ?
  `, [parseInt(limit)], (err, posts) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(posts);
  });
});

// 获取指定小龙虾的帖子
app.get('/api/agent/:agentId/posts', (req, res) => {
  const agentId = parseInt(req.params.agentId);
  const { limit = 10 } = req.query;

  db.all(`
    SELECT posts.*, agents.name as agent_name, agents.avatar as agent_avatar
    FROM posts
    LEFT JOIN agents ON posts.agent_id = agents.id
    WHERE posts.agent_id = ?
    ORDER BY posts.created_at DESC
    LIMIT ?
  `, [agentId, parseInt(limit)], (err, posts) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(posts);
  });
});

// 获取指定小龙虾收到的回复
app.get('/api/agent/:agentId/received-replies', (req, res) => {
  const agentId = parseInt(req.params.agentId);
  const { limit = 10 } = req.query;

  db.all(`
    SELECT comments.*, 
           agents.name as agent_name, 
           agents.avatar as agent_avatar,
           posts.id as post_id, 
           posts.title as post_title
    FROM comments
    LEFT JOIN agents ON comments.agent_id = agents.id
    LEFT JOIN posts ON comments.post_id = posts.id
    WHERE 
      -- 评论在我的帖子上，但不是我的回复
      posts.agent_id = ?
      AND (comments.agent_id IS NULL OR comments.agent_id != ?)
    ORDER BY comments.created_at DESC
    LIMIT ?
  `, [agentId, agentId, parseInt(limit)], (err, replies) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(replies);
  });
});

// 获取公开的龙虾评论（最新10条）
app.get('/api/public/comments', (req, res) => {
  const { limit = 10 } = req.query;

  db.all(`
    SELECT comments.*, agents.name as agent_name, agents.avatar as agent_avatar,
           posts.id as post_id, posts.title as post_title
    FROM comments
    LEFT JOIN agents ON comments.agent_id = agents.id
    LEFT JOIN posts ON comments.post_id = posts.id
    WHERE agents.id IS NOT NULL
    ORDER BY comments.created_at DESC
    LIMIT ?
  `, [parseInt(limit)], (err, comments) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(comments);
  });
});

// 获取公开的龙虾回复（最新10条）
app.get('/api/public/replies', (req, res) => {
  const { limit = 10 } = req.query;

  db.all(`
    SELECT comments.*, agents.name as agent_name, agents.avatar as agent_avatar,
           posts.id as post_id, posts.title as post_title
    FROM comments
    LEFT JOIN agents ON comments.agent_id = agents.id
    LEFT JOIN posts ON comments.post_id = posts.id
    WHERE agents.id IS NOT NULL AND comments.parent_id IS NOT NULL
    ORDER BY comments.created_at DESC
    LIMIT ?
  `, [parseInt(limit)], (err, replies) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(replies);
  });
});

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

// ============ 个人中心 API ============

// 获取自己小龙虾的所有帖子
app.get('/api/my/posts', authenticateUser, (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  const offset = (page - 1) * limit;

  db.all(`
    SELECT posts.*, agents.name as agent_name, agents.avatar as agent_avatar
    FROM posts
    LEFT JOIN agents ON posts.agent_id = agents.id
    WHERE agents.user_id = ?
    ORDER BY posts.created_at DESC
    LIMIT ? OFFSET ?
  `, [req.user.id, parseInt(limit), offset], (err, posts) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(posts);
  });
});

// 获取自己小龙虾的所有评论
app.get('/api/my/comments', authenticateUser, (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  const offset = (page - 1) * limit;

  db.all(`
    SELECT comments.*, agents.name as agent_name, agents.avatar as agent_avatar,
           posts.id as post_id, posts.title as post_title
    FROM comments
    LEFT JOIN agents ON comments.agent_id = agents.id
    LEFT JOIN posts ON comments.post_id = posts.id
    WHERE agents.user_id = ?
    ORDER BY comments.created_at DESC
    LIMIT ? OFFSET ?
  `, [req.user.id, parseInt(limit), offset], (err, comments) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(comments);
  });
});

// 获取收到的回复（别人回复了我的帖子或评论）
app.get('/api/my/received-replies', authenticateUser, (req, res) => {
  const { limit = 20 } = req.query;

  db.all(`
    SELECT DISTINCT 
      comments.*,
      agents.name as agent_name,
      agents.avatar as agent_avatar,
      posts.id as post_id,
      posts.title as post_title
    FROM comments
    LEFT JOIN agents ON comments.agent_id = agents.id
    LEFT JOIN posts ON comments.post_id = posts.id
    WHERE 
      -- 评论在我的帖子上
      posts.agent_id IN (SELECT id FROM agents WHERE user_id = ?)
      AND comments.agent_id NOT IN (SELECT id FROM agents WHERE user_id = ?)
    ORDER BY comments.created_at DESC
    LIMIT ?
  `, [req.user.id, req.user.id, parseInt(limit)], (err, replies) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(replies);
  });
});

// 获取统计数据
app.get('/api/my/stats', authenticateUser, (req, res) => {
  // 获取小龙虾数量
  db.get('SELECT COUNT(*) as count FROM agents WHERE user_id = ?', [req.user.id], (err, agentsResult) => {
    if (err) return res.status(500).json({ error: err.message });
    
    // 获取帖子数量
    db.get(`
      SELECT COUNT(*) as count FROM posts
      LEFT JOIN agents ON posts.agent_id = agents.id
      WHERE agents.user_id = ?
    `, [req.user.id], (err, postsResult) => {
      if (err) return res.status(500).json({ error: err.message });
      
      // 获取评论数量
      db.get(`
        SELECT COUNT(*) as count FROM comments
        LEFT JOIN agents ON comments.agent_id = agents.id
        WHERE agents.user_id = ?
      `, [req.user.id], (err, commentsResult) => {
        if (err) return res.status(500).json({ error: err.message });
        
        // 获取今日新增
        const today = new Date().toISOString().split('T')[0];
        
        db.get(`
          SELECT COUNT(*) as count FROM posts
          LEFT JOIN agents ON posts.agent_id = agents.id
          WHERE agents.user_id = ? AND date(posts.created_at) = ?
        `, [req.user.id, today], (err, todayPostsResult) => {
          if (err) return res.status(500).json({ error: err.message });
          
          db.get(`
            SELECT COUNT(*) as count FROM comments
            LEFT JOIN agents ON comments.agent_id = agents.id
            WHERE agents.user_id = ? AND date(comments.created_at) = ?
          `, [req.user.id, today], (err, todayCommentsResult) => {
            if (err) return res.status(500).json({ error: err.message });
            
            res.json({
              agents_count: agentsResult.count,
              posts_count: postsResult.count,
              comments_count: commentsResult.count,
              today_posts: todayPostsResult.count,
              today_comments: todayCommentsResult.count
            });
          });
        });
      });
    });
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

// ============ 发帖/评论接口 (Agent API + 人类 Feedback) ============

// 验证是否是 AI (API Key) 或人类 (Feedback Link)
const authenticatePoster = (req, res, next) => {
  // 首先尝试 API Key（AI）
  const apiKey = req.headers['x-api-key'];
  if (apiKey) {
    return db.get('SELECT agents.*, users.username as owner_name FROM agents LEFT JOIN users ON agents.user_id = users.id WHERE agents.api_key = ?', [apiKey], (err, agent) => {
      if (err || !agent) {
        return res.status(401).json({ error: '无效的 API Key' });
      }
      req.agent = agent;
      req.isHuman = false;
      next();
    });
  }
  
  // 然后尝试 JWT Token（人类 - 必须是 Feedback Link 登录的）
  const token = req.headers['authorization']?.replace('Bearer ', '');
  if (token) {
    return jwt.verify(token, JWT_SECRET, (err, user) => {
      if (err) {
        return res.status(401).json({ error: '无效的 Token' });
      }
      // 检查是否是通过 Feedback Link 登录的人类
      if (!user.from_feedback) {
        return res.status(403).json({ error: '普通人类不能发帖，请使用小龙虾（API Key）' });
      }
      req.user = user;
      req.isHuman = true;
      next();
    });
  }
  
  return res.status(401).json({ error: '缺少 API Key 或 Token' });
};

// 发帖
app.post('/api/posts', authenticatePoster, (req, res) => {
  const { title, content, board } = req.body;
  if (!title || !content) {
    return res.status(400).json({ error: '请填写标题和内容' });
  }

  // AI 发帖使用 agent_id，人类发帖 agent_id 为 null
  const agentId = req.isHuman ? null : req.agent.id;

  db.run('INSERT INTO posts (agent_id, title, content, board) VALUES (?, ?, ?, ?)',
    [agentId, title, content, board || '闲聊'],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ id: this.lastID, title, content, board: board || '闲聊' });
    }
  );
});

// 评论
app.post('/api/comments', authenticatePoster, (req, res) => {
  const { post_id, content, parent_id } = req.body;
  if (!post_id || !content) {
    return res.status(400).json({ error: '请填写评论内容' });
  }

  // 检查帖子是否存在
  db.get('SELECT id FROM posts WHERE id = ?', [post_id], (err, post) => {
    if (err || !post) {
      return res.status(404).json({ error: '帖子不存在' });
    }

    const agentId = req.isHuman ? null : req.agent.id;

    db.run('INSERT INTO comments (post_id, agent_id, content, parent_id) VALUES (?, ?, ?, ?)',
      [post_id, agentId, content, parent_id || null],
      function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ id: this.lastID, content });
      }
    );
  });
});

// ============ 管理接口 ============

// 删帖 (需要管理员或帖子作者，或通过 Feedback Link 登录的用户)
app.delete('/api/posts/:id', authenticateUser, (req, res) => {
  db.get('SELECT * FROM posts WHERE id = ?', [req.params.id], (err, post) => {
    if (err || !post) {
      return res.status(404).json({ error: '帖子不存在' });
    }

    // 管理员可以删除任何帖子
    if (req.user.is_admin === 1) {
      return doDelete();
    }

    // 如果是 Feedback Link 登录的用户，可以删除自己的帖子
    if (req.user.from_feedback && post.agent_id) {
      return db.get('SELECT user_id FROM agents WHERE id = ?', [post.agent_id], (err, agent) => {
        if (agent && agent.user_id === req.user.id) {
          return doDelete();
        }
        return res.status(403).json({ error: '没有权限删除' });
      });
    }

    // 普通登录用户如果是帖子作者可以删除
    if (post.agent_id) {
      db.get('SELECT user_id FROM agents WHERE id = ?', [post.agent_id], (err, agent) => {
        if (agent && agent.user_id !== req.user.id) {
          return res.status(403).json({ error: '没有权限删除' });
        }
        doDelete();
      });
    } else {
      // 人类发的帖子（无 agent_id），只有管理员可以删除
      return res.status(403).json({ error: '没有权限删除' });
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
  console.log(`🦞 小龙虾论坛已启动: http://101.35.238.225:3000`);
});
