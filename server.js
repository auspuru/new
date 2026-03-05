// Availability Manager - Backend Server
// Node.js + Express + Socket.io

try { require('dotenv').config() } catch {}

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST', 'PATCH', 'DELETE']
  }
});

const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'frontend/dist')));

// In-memory database
const users = [];
const calendarEvents = [];
const tasks = [];
const notifications = [];

// Socket.io user mapping
const userSockets = new Map();

// JWT Auth Middleware
const authMiddleware = (req, res, next) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    req.username = decoded.username;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
};

// Generate unique ID
const generateId = () => uuidv4();

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('register', (userId) => {
    userSockets.set(userId, socket.id);
    console.log(`User ${userId} registered with socket ${socket.id}`);
  });

  socket.on('urgent-request', ({ targetUserId, fromName, message }) => {
    const targetSocketId = userSockets.get(targetUserId);
    if (targetSocketId) {
      io.to(targetSocketId).emit('urgent-notification', { fromName, message });
    }
  });

  socket.on('disconnect', () => {
    for (const [userId, socketId] of userSockets.entries()) {
      if (socketId === socket.id) {
        userSockets.delete(userId);
        break;
      }
    }
    console.log('Client disconnected:', socket.id);
  });
});

// ==================== AUTH ROUTES ====================

// Register
app.post('/api/register', async (req, res) => {
  try {
    const { username, password, displayName } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }
    
    if (users.find(u => u.username === username)) {
      return res.status(400).json({ error: 'Username already exists' });
    }
    
    const passwordHash = await bcrypt.hash(password, 10);
    const user = {
      id: generateId(),
      username,
      passwordHash,
      displayName: displayName || username,
      createdAt: new Date().toISOString()
    };
    
    users.push(user);
    
    const token = jwt.sign(
      { userId: user.id, username: user.username },
      JWT_SECRET,
      { expiresIn: '7d' }
    );
    
    res.json({
      token,
      user: { id: user.id, username: user.username, displayName: user.displayName }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Login
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    const user = users.find(u => u.username === username);
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    const token = jwt.sign(
      { userId: user.id, username: user.username },
      JWT_SECRET,
      { expiresIn: '7d' }
    );
    
    res.json({
      token,
      user: { id: user.id, username: user.username, displayName: user.displayName }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get current user
app.get('/api/me', authMiddleware, (req, res) => {
  const user = users.find(u => u.id === req.userId);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }
  res.json({
    id: user.id,
    username: user.username,
    displayName: user.displayName
  });
});

// ==================== PUBLIC ROUTES ====================

// Get public profile
app.get('/api/public/:username', (req, res) => {
  const user = users.find(u => u.username === req.params.username);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }
  
  // Get current status based on events
  const now = new Date();
  const currentEvent = calendarEvents.find(e => 
    e.userId === user.id && 
    e.isPublic &&
    new Date(e.start) <= now && 
    new Date(e.end) >= now
  );
  
  const status = currentEvent ? currentEvent.type : 'available';
  
  // Get upcoming public events (next 7 days)
  const sevenDaysLater = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const upcomingEvents = calendarEvents
    .filter(e => 
      e.userId === user.id && 
      e.isPublic &&
      new Date(e.start) >= now &&
      new Date(e.start) <= sevenDaysLater
    )
    .sort((a, b) => new Date(a.start) - new Date(b.start));
  
  res.json({
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    status,
    upcomingEvents
  });
});

// ==================== CALENDAR ROUTES ====================

// Get calendar events for a user
app.get('/api/calendar/:userId', authMiddleware, (req, res) => {
  const { userId } = req.params;
  // Only allow access to own calendar or public events of others
  const events = calendarEvents.filter(e => 
    e.userId === userId && (e.userId === req.userId || e.isPublic)
  );
  res.json(events);
});

// Create event
app.post('/api/events', authMiddleware, (req, res) => {
  try {
    const { title, start, end, type, isPublic } = req.body;
    
    const colors = {
      busy: '#ef4444',
      meeting: '#f97316',
      focus: '#8b5cf6',
      break: '#22c55e'
    };
    
    const event = {
      id: generateId(),
      userId: req.userId,
      title: title || 'Untitled',
      start,
      end,
      type: type || 'busy',
      isPublic: isPublic !== undefined ? isPublic : true,
      color: colors[type] || colors.busy,
      createdAt: new Date().toISOString()
    };
    
    calendarEvents.push(event);
    res.json(event);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete event
app.delete('/api/events/:eventId', authMiddleware, (req, res) => {
  const { eventId } = req.params;
  const index = calendarEvents.findIndex(e => e.id === eventId && e.userId === req.userId);
  
  if (index === -1) {
    return res.status(404).json({ error: 'Event not found' });
  }
  
  calendarEvents.splice(index, 1);
  res.json({ success: true });
});

// ==================== TASK ROUTES ====================

// Assign task (no auth required)
app.post('/api/tasks/assign', (req, res) => {
  try {
    const { userId, title, description, dueDate, priority, assignerName, urgent } = req.body;
    
    if (!userId || !title) {
      return res.status(400).json({ error: 'User ID and title required' });
    }
    
    const task = {
      id: generateId(),
      userId,
      title,
      description: description || '',
      dueDate: dueDate || null,
      priority: priority || 'medium',
      assignerName: assignerName || 'Anonymous',
      urgent: urgent || false,
      completed: false,
      createdAt: new Date().toISOString()
    };
    
    tasks.push(task);
    
    // Create notification
    const notification = {
      id: generateId(),
      userId,
      message: `${assignerName || 'Someone'} assigned you a task: ${title}`,
      type: urgent ? 'urgent' : 'task',
      taskId: task.id,
      read: false,
      createdAt: new Date().toISOString()
    };
    
    notifications.push(notification);
    
    // Send real-time notification
    const targetSocketId = userSockets.get(userId);
    if (targetSocketId) {
      io.to(targetSocketId).emit('new-notification', notification);
      io.to(targetSocketId).emit('new-task', task);
    }
    
    res.json(task);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get tasks for a user
app.get('/api/tasks/:userId', authMiddleware, (req, res) => {
  const { userId } = req.params;
  if (userId !== req.userId) {
    return res.status(403).json({ error: 'Access denied' });
  }
  
  const userTasks = tasks.filter(t => t.userId === userId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(userTasks);
});

// Update task (complete/pending)
app.patch('/api/tasks/:taskId', authMiddleware, (req, res) => {
  const { taskId } = req.params;
  const { completed } = req.body;
  
  const task = tasks.find(t => t.id === taskId && t.userId === req.userId);
  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }
  
  task.completed = completed !== undefined ? completed : task.completed;
  res.json(task);
});

// ==================== NOTIFICATION ROUTES ====================

// Get notifications for a user
app.get('/api/notifications/:userId', authMiddleware, (req, res) => {
  const { userId } = req.params;
  if (userId !== req.userId) {
    return res.status(403).json({ error: 'Access denied' });
  }
  
  const userNotifications = notifications
    .filter(n => n.userId === userId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(userNotifications);
});

// Mark notification as read
app.patch('/api/notifications/:id/read', authMiddleware, (req, res) => {
  const { id } = req.params;
  const notification = notifications.find(n => n.id === id && n.userId === req.userId);
  
  if (!notification) {
    return res.status(404).json({ error: 'Notification not found' });
  }
  
  notification.read = true;
  res.json(notification);
});

// Mark all notifications as read
app.patch('/api/notifications/read-all/:userId', authMiddleware, (req, res) => {
  const { userId } = req.params;
  if (userId !== req.userId) {
    return res.status(403).json({ error: 'Access denied' });
  }
  
  notifications.filter(n => n.userId === userId).forEach(n => n.read = true);
  res.json({ success: true });
});

// ==================== HEALTH CHECK ====================

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ==================== SPA FALLBACK ====================

// All non-API routes return the React app
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api') && !req.path.startsWith('/socket.io')) {
    res.sendFile(path.join(__dirname, 'frontend/dist/index.html'));
  }
});

// Start server
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
