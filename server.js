const express = require('express');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcryptjs');
const swaggerUi = require('swagger-ui-express');
const swaggerJsdoc = require('swagger-jsdoc');
const pool = require('./db');

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 3000;

app.use(cors());
app.use(express.json());

// Cache-Control: força navegadores a buscar HTML/JS atualizados a cada deploy
app.use((req, res, next) => {
  if (req.url.endsWith('.html') || req.url.endsWith('.js') || req.url === '/') {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  }
  next();
});

// Caminho absoluto: com caminho relativo o diretório dependia do cwd que o
// Passenger escolhe, e a camada de estáticos da Hostinger serviu cópia velha.
app.use(express.static(path.join(__dirname, 'public')));

const LIVRO_SELECT = `
  id,
  nome,
  autor,
  paginas,
  descricao,
  imagem_url   AS imagemUrl,
  data_cadastro AS dataCadastro,
  estoque,
  preco
`;

const ARRENDAMENTO_SELECT = `
  id,
  usuario_id   AS usuarioId,
  livro_id     AS livroId,
  data_inicio  AS dataInicio,
  data_fim     AS dataFim,
  status,
  criado_em    AS criadoEm
`;

const COMPRA_SELECT = `
  id,
  usuario_id AS usuarioId,
  livro_id   AS livroId,
  quantidade,
  total,
  status,
  criado_em  AS criadoEm
`;

const USUARIO_SELECT = `id, nome, email, tipo`;

/**
 * @swagger
 * components:
 *   schemas:
 *     Usuario:
 *       type: object
 *       properties:
 *         id: { type: integer }
 *         nome: { type: string }
 *         email: { type: string }
 *         tipo:
 *           type: integer
 *           description: 1 = Aluno, 2 = Funcionário, 3 = Admin
 *     NovoUsuario:
 *       type: object
 *       required: [nome, email, senha]
 *       properties:
 *         nome: { type: string }
 *         email: { type: string }
 *         senha: { type: string }
 *         tipo:
 *           type: integer
 *           description: Opcional. Se não informado, assume 1 (Aluno)
 *     LoginRequest:
 *       type: object
 *       required: [email, senha]
 *       properties:
 *         email: { type: string }
 *         senha: { type: string }
 *     Livro:
 *       type: object
 *       properties:
 *         id: { type: integer }
 *         nome: { type: string }
 *         autor: { type: string }
 *         paginas: { type: integer }
 *         descricao: { type: string }
 *         imagemUrl: { type: string }
 *         dataCadastro: { type: string, format: date-time }
 *         estoque: { type: integer }
 *         preco: { type: number, format: float }
 *     NovoLivro:
 *       type: object
 *       required: [nome, autor, paginas]
 *       properties:
 *         nome: { type: string }
 *         autor: { type: string }
 *         paginas: { type: integer }
 *         descricao: { type: string }
 *         imagemUrl: { type: string }
 *         estoque: { type: integer }
 *         preco: { type: number, format: float }
 *     FavoritoRequest:
 *       type: object
 *       required: [usuarioId, livroId]
 *       properties:
 *         usuarioId: { type: integer }
 *         livroId: { type: integer }
 *     Arrendamento:
 *       type: object
 *       properties:
 *         id: { type: integer }
 *         usuarioId: { type: integer }
 *         livroId: { type: integer }
 *         dataInicio: { type: string }
 *         dataFim: { type: string }
 *         status: { type: string, enum: [PENDENTE, APROVADO, REJEITADO] }
 *         criadoEm: { type: string, format: date-time }
 *     NovoArrendamento:
 *       type: object
 *       required: [usuarioId, livroId, dataInicio, dataFim]
 *       properties:
 *         usuarioId: { type: integer }
 *         livroId: { type: integer }
 *         dataInicio: { type: string }
 *         dataFim: { type: string }
 *     AtualizaStatusArrendamento:
 *       type: object
 *       required: [status]
 *       properties:
 *         status: { type: string, enum: [APROVADO, REJEITADO] }
 *     Compra:
 *       type: object
 *       properties:
 *         id: { type: integer }
 *         usuarioId: { type: integer }
 *         livroId: { type: integer }
 *         quantidade: { type: integer }
 *         total: { type: number }
 *         status: { type: string, enum: [PENDENTE, APROVADA, CANCELADA] }
 *         criadoEm: { type: string, format: date-time }
 *     NovaCompra:
 *       type: object
 *       required: [usuarioId, livroId, quantidade]
 *       properties:
 *         usuarioId: { type: integer }
 *         livroId: { type: integer }
 *         quantidade: { type: integer }
 *     AtualizaStatusCompra:
 *       type: object
 *       required: [status]
 *       properties:
 *         status: { type: string, enum: [APROVADA, CANCELADA] }
 */

// ==================== AUTENTICAÇÃO ====================

/**
 * @swagger
 * /registro:
 *   post:
 *     summary: Registra um novo usuário
 *     tags: [Autenticação]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/NovoUsuario' }
 *     responses:
 *       201: { description: Usuário criado com sucesso }
 *       400: { description: Email já cadastrado ou dados inválidos }
 */
app.post('/registro', async (req, res) => {
  try {
    const { nome, email, senha, tipo } = req.body;

    if (!nome || !email || !senha) {
      return res.status(400).json({ mensagem: 'Nome, email e senha são obrigatórios' });
    }

    const [existentes] = await pool.query('SELECT id FROM usuarios WHERE email = ?', [email]);
    if (existentes.length > 0) {
      return res.status(400).json({ mensagem: 'Email já cadastrado' });
    }

    let tipoFinal = 1;
    if ([1, 2, 3].includes(parseInt(tipo))) tipoFinal = parseInt(tipo);

    const senhaHash = bcrypt.hashSync(senha, 10);

    const [result] = await pool.query(
      'INSERT INTO usuarios (nome, email, senha, tipo) VALUES (?, ?, ?, ?)',
      [nome, email, senhaHash, tipoFinal]
    );

    res.status(201).json({
      mensagem: 'Usuário criado com sucesso',
      usuario: { id: result.insertId, nome, email, tipo: tipoFinal }
    });
  } catch (err) {
    console.error('Erro /registro:', err);
    res.status(500).json({ mensagem: 'Erro interno' });
  }
});

/**
 * @swagger
 * /login:
 *   post:
 *     summary: Realiza login de usuário
 *     tags: [Autenticação]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/LoginRequest' }
 *     responses:
 *       200: { description: Login realizado com sucesso }
 *       401: { description: Email ou senha incorretos }
 */
app.post('/login', async (req, res) => {
  try {
    const { email, senha } = req.body;
    const [rows] = await pool.query(
      'SELECT id, nome, email, senha, tipo FROM usuarios WHERE email = ?',
      [email]
    );

    const usuario = rows[0];
    if (!usuario || !bcrypt.compareSync(senha || '', usuario.senha)) {
      return res.status(401).json({ mensagem: 'Email ou senha incorretos' });
    }

    res.json({
      mensagem: 'Login realizado com sucesso',
      usuario: { id: usuario.id, nome: usuario.nome, email: usuario.email, tipo: usuario.tipo }
    });
  } catch (err) {
    console.error('Erro /login:', err);
    res.status(500).json({ mensagem: 'Erro interno' });
  }
});

// ==================== USUÁRIOS ====================

/**
 * @swagger
 * /usuarios:
 *   get:
 *     summary: Lista todos os usuários (sem senha)
 *     tags: [Usuários]
 *     responses:
 *       200: { description: Lista de usuários }
 */
app.get('/usuarios', async (req, res) => {
  try {
    const [rows] = await pool.query(`SELECT ${USUARIO_SELECT} FROM usuarios ORDER BY id`);
    res.json(rows);
  } catch (err) {
    console.error('Erro GET /usuarios:', err);
    res.status(500).json({ mensagem: 'Erro interno' });
  }
});

/**
 * @swagger
 * /usuarios/{id}:
 *   put:
 *     summary: Atualiza dados de um usuário
 *     tags: [Usuários]
 *     parameters:
 *       - in: path
 *         name: id
 *         schema: { type: integer }
 *         required: true
 *     responses:
 *       200: { description: Usuário atualizado }
 *       404: { description: Usuário não encontrado }
 */
app.put('/usuarios/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { nome, email, tipo } = req.body;

    const [rows] = await pool.query('SELECT id, nome, email, tipo FROM usuarios WHERE id = ?', [id]);
    const usuario = rows[0];
    if (!usuario) return res.status(404).json({ mensagem: 'Usuário não encontrado' });

    const novoNome  = nome  || usuario.nome;
    const novoEmail = email || usuario.email;
    const novoTipo  = [1, 2, 3].includes(parseInt(tipo)) ? parseInt(tipo) : usuario.tipo;

    await pool.query(
      'UPDATE usuarios SET nome = ?, email = ?, tipo = ? WHERE id = ?',
      [novoNome, novoEmail, novoTipo, id]
    );

    res.json({ id, nome: novoNome, email: novoEmail, tipo: novoTipo });
  } catch (err) {
    console.error('Erro PUT /usuarios:', err);
    res.status(500).json({ mensagem: 'Erro interno' });
  }
});

/**
 * @swagger
 * /usuarios/{id}:
 *   delete:
 *     summary: Remove um usuário
 *     tags: [Usuários]
 *     parameters:
 *       - in: path
 *         name: id
 *         schema: { type: integer }
 *         required: true
 *     responses:
 *       200: { description: Usuário deletado com sucesso }
 *       403: { description: Tentativa de excluir o admin principal }
 *       404: { description: Usuário não encontrado }
 */
app.delete('/usuarios/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (id === 1) return res.status(403).json({ mensagem: 'Admin principal não pode ser deletado' });

    const [result] = await pool.query('DELETE FROM usuarios WHERE id = ?', [id]);
    if (result.affectedRows === 0) return res.status(404).json({ mensagem: 'Usuário não encontrado' });

    res.json({ mensagem: 'Usuário deletado com sucesso' });
  } catch (err) {
    console.error('Erro DELETE /usuarios:', err);
    res.status(500).json({ mensagem: 'Erro interno' });
  }
});

// ==================== LIVROS ====================

/**
 * @swagger
 * /livros:
 *   get:
 *     summary: Lista todos os livros
 *     tags: [Livros]
 *     responses:
 *       200: { description: Lista de livros }
 */
app.get('/livros', async (req, res) => {
  try {
    const [rows] = await pool.query(`SELECT ${LIVRO_SELECT} FROM livros ORDER BY id`);
    res.json(rows);
  } catch (err) {
    console.error('Erro GET /livros:', err);
    res.status(500).json({ mensagem: 'Erro interno' });
  }
});

/**
 * @swagger
 * /livros/disponiveis:
 *   get:
 *     summary: Lista livros com estoque > 0
 *     tags: [Livros]
 *     responses:
 *       200: { description: Lista de livros disponíveis }
 */
app.get('/livros/disponiveis', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT ${LIVRO_SELECT} FROM livros WHERE estoque > 0 ORDER BY id`
    );
    const comFlag = rows.map(l => ({ ...l, disponivel: true }));
    res.json(comFlag);
  } catch (err) {
    console.error('Erro GET /livros/disponiveis:', err);
    res.status(500).json({ mensagem: 'Erro interno' });
  }
});

/**
 * @swagger
 * /livros/recentes/ultimos:
 *   get:
 *     summary: Lista os últimos 5 livros cadastrados
 *     tags: [Livros]
 *     responses:
 *       200: { description: Lista de livros recentes }
 */
app.get('/livros/recentes/ultimos', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT ${LIVRO_SELECT} FROM livros ORDER BY data_cadastro DESC LIMIT 5`
    );
    res.json(rows);
  } catch (err) {
    console.error('Erro GET /livros/recentes/ultimos:', err);
    res.status(500).json({ mensagem: 'Erro interno' });
  }
});

/**
 * @swagger
 * /livros/{id}:
 *   get:
 *     summary: Busca um livro por ID
 *     tags: [Livros]
 *     parameters:
 *       - in: path
 *         name: id
 *         schema: { type: integer }
 *         required: true
 *     responses:
 *       200: { description: Livro encontrado }
 *       404: { description: Livro não encontrado }
 */
app.get('/livros/:id', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT ${LIVRO_SELECT} FROM livros WHERE id = ?`,
      [parseInt(req.params.id, 10)]
    );
    if (rows.length === 0) return res.status(404).json({ mensagem: 'Livro não encontrado' });
    res.json(rows[0]);
  } catch (err) {
    console.error('Erro GET /livros/:id:', err);
    res.status(500).json({ mensagem: 'Erro interno' });
  }
});

/**
 * @swagger
 * /livros:
 *   post:
 *     summary: Cria um novo livro
 *     tags: [Livros]
 *     responses:
 *       201: { description: Livro criado }
 *       400: { description: Campos obrigatórios não informados }
 */
app.post('/livros', async (req, res) => {
  try {
    const { nome, autor, paginas, descricao, imagemUrl, estoque = 1, preco = 0 } = req.body;
    if (!nome || !autor || !paginas) {
      return res.status(400).json({ mensagem: 'Nome, autor e páginas são obrigatórios' });
    }

    const [result] = await pool.query(
      `INSERT INTO livros (nome, autor, paginas, descricao, imagem_url, estoque, preco)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        nome,
        autor,
        parseInt(paginas, 10),
        descricao || '',
        imagemUrl || 'https://via.placeholder.com/150',
        parseInt(estoque, 10),
        parseFloat(preco)
      ]
    );

    const [rows] = await pool.query(
      `SELECT ${LIVRO_SELECT} FROM livros WHERE id = ?`,
      [result.insertId]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('Erro POST /livros:', err);
    res.status(500).json({ mensagem: 'Erro interno' });
  }
});

/**
 * @swagger
 * /livros/{id}:
 *   put:
 *     summary: Atualiza dados de um livro
 *     tags: [Livros]
 *     parameters:
 *       - in: path
 *         name: id
 *         schema: { type: integer }
 *         required: true
 *     responses:
 *       200: { description: Livro atualizado }
 *       404: { description: Livro não encontrado }
 */
app.put('/livros/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);

    const [rows] = await pool.query(`SELECT ${LIVRO_SELECT} FROM livros WHERE id = ?`, [id]);
    const livro = rows[0];
    if (!livro) return res.status(404).json({ mensagem: 'Livro não encontrado' });

    const { nome, autor, paginas, descricao, imagemUrl, estoque, preco } = req.body;

    const novo = {
      nome:       nome       !== undefined ? nome        : livro.nome,
      autor:      autor      !== undefined ? autor       : livro.autor,
      paginas:    paginas    !== undefined ? parseInt(paginas, 10) : livro.paginas,
      descricao:  descricao  !== undefined ? descricao   : livro.descricao,
      imagemUrl:  imagemUrl  !== undefined ? imagemUrl   : livro.imagemUrl,
      estoque:    estoque    !== undefined ? Math.max(0, parseInt(estoque, 10)) : livro.estoque,
      preco:      preco      !== undefined ? parseFloat(preco) : livro.preco
    };

    await pool.query(
      `UPDATE livros
         SET nome = ?, autor = ?, paginas = ?, descricao = ?, imagem_url = ?, estoque = ?, preco = ?
       WHERE id = ?`,
      [novo.nome, novo.autor, novo.paginas, novo.descricao, novo.imagemUrl, novo.estoque, novo.preco, id]
    );

    const [atualizado] = await pool.query(`SELECT ${LIVRO_SELECT} FROM livros WHERE id = ?`, [id]);
    res.json(atualizado[0]);
  } catch (err) {
    console.error('Erro PUT /livros:', err);
    res.status(500).json({ mensagem: 'Erro interno' });
  }
});

/**
 * @swagger
 * /livros/{id}:
 *   delete:
 *     summary: Remove um livro
 *     tags: [Livros]
 *     parameters:
 *       - in: path
 *         name: id
 *         schema: { type: integer }
 *         required: true
 *     responses:
 *       200: { description: Livro removido }
 *       404: { description: Livro não encontrado }
 */
app.delete('/livros/:id', async (req, res) => {
  try {
    const [result] = await pool.query('DELETE FROM livros WHERE id = ?', [parseInt(req.params.id, 10)]);
    if (result.affectedRows === 0) return res.status(404).json({ mensagem: 'Livro não encontrado' });
    res.json({ mensagem: 'Livro removido' });
  } catch (err) {
    console.error('Erro DELETE /livros:', err);
    res.status(500).json({ mensagem: 'Erro interno' });
  }
});

// ==================== ESTATÍSTICAS ====================

/**
 * @swagger
 * /estatisticas:
 *   get:
 *     summary: Retorna estatísticas gerais da biblioteca
 *     tags: [Estatísticas]
 *     responses:
 *       200: { description: Estatísticas retornadas com sucesso }
 */
app.get('/estatisticas', async (req, res) => {
  try {
    const [[livrosStat]] = await pool.query(
      'SELECT COUNT(*) AS totalLivros, COALESCE(SUM(paginas), 0) AS totalPaginas, SUM(CASE WHEN estoque > 0 THEN 1 ELSE 0 END) AS livrosDisponiveis FROM livros'
    );
    const [[usuariosStat]] = await pool.query(
      `SELECT
         COUNT(*) AS totalUsuarios,
         SUM(CASE WHEN tipo = 1 THEN 1 ELSE 0 END) AS alunos,
         SUM(CASE WHEN tipo = 2 THEN 1 ELSE 0 END) AS funcionarios,
         SUM(CASE WHEN tipo = 3 THEN 1 ELSE 0 END) AS admins
       FROM usuarios`
    );
    const [[arrPend]] = await pool.query(
      "SELECT COUNT(*) AS arrendamentosPendentes FROM arrendamentos WHERE status = 'PENDENTE'"
    );
    const [[comPend]] = await pool.query(
      "SELECT COUNT(*) AS comprasPendentes FROM compras WHERE status = 'PENDENTE'"
    );

    res.json({
      totalLivros: Number(livrosStat.totalLivros) || 0,
      totalPaginas: Number(livrosStat.totalPaginas) || 0,
      totalUsuarios: Number(usuariosStat.totalUsuarios) || 0,
      usuariosPorTipo: {
        alunos: Number(usuariosStat.alunos) || 0,
        funcionarios: Number(usuariosStat.funcionarios) || 0,
        admins: Number(usuariosStat.admins) || 0
      },
      livrosDisponiveis: Number(livrosStat.livrosDisponiveis) || 0,
      arrendamentosPendentes: Number(arrPend.arrendamentosPendentes) || 0,
      comprasPendentes: Number(comPend.comprasPendentes) || 0
    });
  } catch (err) {
    console.error('Erro GET /estatisticas:', err);
    res.status(500).json({ mensagem: 'Erro interno' });
  }
});

// ==================== FAVORITOS ====================

/**
 * @swagger
 * /favoritos/{usuarioId}:
 *   get:
 *     summary: Lista livros favoritos de um usuário
 *     tags: [Favoritos]
 *     parameters:
 *       - in: path
 *         name: usuarioId
 *         schema: { type: integer }
 *         required: true
 *     responses:
 *       200: { description: Lista de livros favoritos }
 */
app.get('/favoritos/:usuarioId', async (req, res) => {
  try {
    const usuarioId = parseInt(req.params.usuarioId, 10);
    const [rows] = await pool.query(
      `SELECT l.id, l.nome, l.autor, l.paginas, l.descricao,
              l.imagem_url AS imagemUrl, l.data_cadastro AS dataCadastro,
              l.estoque, l.preco
         FROM favoritos f
         JOIN livros l ON l.id = f.livro_id
        WHERE f.usuario_id = ?
        ORDER BY l.id`,
      [usuarioId]
    );
    res.json(rows);
  } catch (err) {
    console.error('Erro GET /favoritos:', err);
    res.status(500).json({ mensagem: 'Erro interno' });
  }
});

/**
 * @swagger
 * /favoritos:
 *   post:
 *     summary: Adiciona um livro aos favoritos
 *     tags: [Favoritos]
 *     responses:
 *       201: { description: Livro adicionado aos favoritos }
 *       400: { description: Já está nos favoritos }
 */
app.post('/favoritos', async (req, res) => {
  try {
    const usuarioId = parseInt(req.body.usuarioId, 10);
    const livroId = parseInt(req.body.livroId, 10);

    const [existentes] = await pool.query(
      'SELECT 1 FROM favoritos WHERE usuario_id = ? AND livro_id = ?',
      [usuarioId, livroId]
    );
    if (existentes.length > 0) return res.status(400).json({ mensagem: 'Já está nos favoritos' });

    await pool.query(
      'INSERT INTO favoritos (usuario_id, livro_id) VALUES (?, ?)',
      [usuarioId, livroId]
    );
    res.status(201).json({ mensagem: 'Livro adicionado aos favoritos' });
  } catch (err) {
    console.error('Erro POST /favoritos:', err);
    res.status(500).json({ mensagem: 'Erro interno' });
  }
});

/**
 * @swagger
 * /favoritos:
 *   delete:
 *     summary: Remove um livro dos favoritos
 *     tags: [Favoritos]
 *     responses:
 *       200: { description: Livro removido dos favoritos }
 *       404: { description: Favorito não encontrado }
 */
app.delete('/favoritos', async (req, res) => {
  try {
    const usuarioId = parseInt(req.body.usuarioId, 10);
    const livroId = parseInt(req.body.livroId, 10);
    const [result] = await pool.query(
      'DELETE FROM favoritos WHERE usuario_id = ? AND livro_id = ?',
      [usuarioId, livroId]
    );
    if (result.affectedRows === 0) return res.status(404).json({ mensagem: 'Favorito não encontrado' });
    res.json({ mensagem: 'Livro removido dos favoritos' });
  } catch (err) {
    console.error('Erro DELETE /favoritos:', err);
    res.status(500).json({ mensagem: 'Erro interno' });
  }
});

// ==================== ARRENDAMENTOS ====================

/**
 * @swagger
 * /arrendamentos:
 *   get:
 *     summary: Lista todos os arrendamentos
 *     tags: [Arrendamentos]
 *     responses:
 *       200: { description: Lista de arrendamentos }
 */
app.get('/arrendamentos', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT ${ARRENDAMENTO_SELECT} FROM arrendamentos ORDER BY id`
    );
    res.json(rows);
  } catch (err) {
    console.error('Erro GET /arrendamentos:', err);
    res.status(500).json({ mensagem: 'Erro interno' });
  }
});

/**
 * @swagger
 * /arrendamentos/me:
 *   get:
 *     summary: Lista arrendamentos de um usuário
 *     tags: [Arrendamentos]
 *     parameters:
 *       - in: query
 *         name: usuarioId
 *         schema: { type: integer }
 *         required: true
 *     responses:
 *       200: { description: Lista de arrendamentos do usuário }
 *       400: { description: usuarioId não informado }
 */
app.get('/arrendamentos/me', async (req, res) => {
  try {
    const usuarioId = parseInt(req.query.usuarioId, 10);
    if (!usuarioId) return res.status(400).json({ mensagem: 'usuarioId é obrigatório na query' });

    const [rows] = await pool.query(
      `SELECT ${ARRENDAMENTO_SELECT} FROM arrendamentos WHERE usuario_id = ? ORDER BY id`,
      [usuarioId]
    );
    res.json(rows);
  } catch (err) {
    console.error('Erro GET /arrendamentos/me:', err);
    res.status(500).json({ mensagem: 'Erro interno' });
  }
});

/**
 * @swagger
 * /arrendamentos:
 *   post:
 *     summary: Cria um novo arrendamento
 *     tags: [Arrendamentos]
 *     responses:
 *       201: { description: Arrendamento criado }
 *       400: { description: Livro sem estoque }
 *       404: { description: Livro não encontrado }
 */
app.post('/arrendamentos', async (req, res) => {
  try {
    const usuarioId = parseInt(req.body.usuarioId, 10);
    const livroId = parseInt(req.body.livroId, 10);
    const { dataInicio, dataFim } = req.body;

    const [livros] = await pool.query('SELECT id, estoque FROM livros WHERE id = ?', [livroId]);
    const livro = livros[0];
    if (!livro) return res.status(404).json({ mensagem: 'Livro não encontrado' });
    if (livro.estoque <= 0) return res.status(400).json({ mensagem: 'Livro sem estoque para arrendamento' });

    const [result] = await pool.query(
      `INSERT INTO arrendamentos (usuario_id, livro_id, data_inicio, data_fim, status)
       VALUES (?, ?, ?, ?, 'PENDENTE')`,
      [usuarioId, livroId, dataInicio, dataFim]
    );

    const [rows] = await pool.query(
      `SELECT ${ARRENDAMENTO_SELECT} FROM arrendamentos WHERE id = ?`,
      [result.insertId]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('Erro POST /arrendamentos:', err);
    res.status(500).json({ mensagem: 'Erro interno' });
  }
});

/**
 * @swagger
 * /arrendamentos/{id}/status:
 *   put:
 *     summary: Atualiza o status de um arrendamento
 *     tags: [Arrendamentos]
 *     parameters:
 *       - in: path
 *         name: id
 *         schema: { type: integer }
 *         required: true
 *     responses:
 *       200: { description: Arrendamento atualizado }
 *       400: { description: Status inválido }
 *       404: { description: Arrendamento não encontrado }
 */
app.put('/arrendamentos/:id/status', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { status } = req.body;
    if (!['APROVADO', 'REJEITADO'].includes(status)) {
      return res.status(400).json({ mensagem: 'Status inválido' });
    }

    const [rows] = await pool.query(
      `SELECT ${ARRENDAMENTO_SELECT} FROM arrendamentos WHERE id = ?`,
      [id]
    );
    const arr = rows[0];
    if (!arr) return res.status(404).json({ mensagem: 'Arrendamento não encontrado' });

    await pool.query('UPDATE arrendamentos SET status = ? WHERE id = ?', [status, id]);

    if (status === 'APROVADO') {
      await pool.query(
        'UPDATE livros SET estoque = estoque - 1 WHERE id = ? AND estoque > 0',
        [arr.livroId]
      );
    }

    const [atualizado] = await pool.query(
      `SELECT ${ARRENDAMENTO_SELECT} FROM arrendamentos WHERE id = ?`,
      [id]
    );
    res.json(atualizado[0]);
  } catch (err) {
    console.error('Erro PUT /arrendamentos/:id/status:', err);
    res.status(500).json({ mensagem: 'Erro interno' });
  }
});

// ==================== COMPRAS ====================

/**
 * @swagger
 * /compras:
 *   get:
 *     summary: Lista todas as compras
 *     tags: [Compras]
 *     responses:
 *       200: { description: Lista de compras }
 */
app.get('/compras', async (req, res) => {
  try {
    const [rows] = await pool.query(`SELECT ${COMPRA_SELECT} FROM compras ORDER BY id`);
    res.json(rows);
  } catch (err) {
    console.error('Erro GET /compras:', err);
    res.status(500).json({ mensagem: 'Erro interno' });
  }
});

/**
 * @swagger
 * /compras/me:
 *   get:
 *     summary: Lista compras de um usuário
 *     tags: [Compras]
 *     parameters:
 *       - in: query
 *         name: usuarioId
 *         schema: { type: integer }
 *         required: true
 *     responses:
 *       200: { description: Lista de compras do usuário }
 *       400: { description: usuarioId não informado }
 */
app.get('/compras/me', async (req, res) => {
  try {
    const usuarioId = parseInt(req.query.usuarioId, 10);
    if (!usuarioId) return res.status(400).json({ mensagem: 'usuarioId é obrigatório na query' });

    const [rows] = await pool.query(
      `SELECT ${COMPRA_SELECT} FROM compras WHERE usuario_id = ? ORDER BY id`,
      [usuarioId]
    );
    res.json(rows);
  } catch (err) {
    console.error('Erro GET /compras/me:', err);
    res.status(500).json({ mensagem: 'Erro interno' });
  }
});

/**
 * @swagger
 * /compras:
 *   post:
 *     summary: Cria uma nova compra
 *     tags: [Compras]
 *     responses:
 *       201: { description: Compra criada }
 *       400: { description: Quantidade inválida ou estoque insuficiente }
 *       404: { description: Livro não encontrado }
 */
app.post('/compras', async (req, res) => {
  try {
    const usuarioId = parseInt(req.body.usuarioId, 10);
    const livroId = parseInt(req.body.livroId, 10);
    const qtd = parseInt(req.body.quantidade, 10);

    if (isNaN(qtd) || qtd <= 0) return res.status(400).json({ mensagem: 'Quantidade inválida' });

    const [livros] = await pool.query('SELECT id, estoque, preco FROM livros WHERE id = ?', [livroId]);
    const livro = livros[0];
    if (!livro) return res.status(404).json({ mensagem: 'Livro não encontrado' });
    if (livro.estoque < qtd) return res.status(400).json({ mensagem: 'Estoque insuficiente' });

    const total = (Number(livro.preco) || 0) * qtd;

    const [result] = await pool.query(
      `INSERT INTO compras (usuario_id, livro_id, quantidade, total, status)
       VALUES (?, ?, ?, ?, 'PENDENTE')`,
      [usuarioId, livroId, qtd, total]
    );

    const [rows] = await pool.query(
      `SELECT ${COMPRA_SELECT} FROM compras WHERE id = ?`,
      [result.insertId]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('Erro POST /compras:', err);
    res.status(500).json({ mensagem: 'Erro interno' });
  }
});

/**
 * @swagger
 * /compras/{id}/status:
 *   put:
 *     summary: Atualiza o status de uma compra
 *     tags: [Compras]
 *     parameters:
 *       - in: path
 *         name: id
 *         schema: { type: integer }
 *         required: true
 *     responses:
 *       200: { description: Compra atualizada }
 *       400: { description: Status inválido ou estoque insuficiente para aprovar }
 *       404: { description: Compra ou livro não encontrado }
 */
app.put('/compras/:id/status', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { status } = req.body;

    if (!['APROVADA', 'CANCELADA'].includes(status)) {
      return res.status(400).json({ mensagem: 'Status inválido' });
    }

    const [rows] = await pool.query(`SELECT ${COMPRA_SELECT} FROM compras WHERE id = ?`, [id]);
    const compra = rows[0];
    if (!compra) return res.status(404).json({ mensagem: 'Compra não encontrada' });

    if (status === 'APROVADA' && compra.status === 'PENDENTE') {
      const [livros] = await pool.query('SELECT id, estoque FROM livros WHERE id = ?', [compra.livroId]);
      const livro = livros[0];
      if (!livro) return res.status(404).json({ mensagem: 'Livro não encontrado' });
      if (livro.estoque < compra.quantidade) {
        return res.status(400).json({ mensagem: 'Estoque insuficiente para aprovar' });
      }
      await pool.query('UPDATE livros SET estoque = estoque - ? WHERE id = ?', [compra.quantidade, compra.livroId]);
    }

    await pool.query('UPDATE compras SET status = ? WHERE id = ?', [status, id]);

    const [atualizado] = await pool.query(`SELECT ${COMPRA_SELECT} FROM compras WHERE id = ?`, [id]);
    res.json(atualizado[0]);
  } catch (err) {
    console.error('Erro PUT /compras/:id/status:', err);
    res.status(500).json({ mensagem: 'Erro interno' });
  }
});

// ==================== RESET MANUAL ====================
// Zera dados de domínio E remove usuários cadastrados pelos clientes, mantendo
// apenas os 3 usuários iniciais (admin, funcionário, aluno). Era um setInterval
// de 1h, mas o timer mantinha o processo sempre vivo para o LiteSpeed, que
// nunca reciclava a instância — e cada instância residente conta contra o
// limite de 120 processos compartilhado da conta. Agora o reset é disparado
// pela página /reset.html (ou POST /reset) quando alguém precisar dele.

const SEED_PASSWORD_HASH = '$2a$10$0LBTu0kBOfcz5vqFlk8wTuY1TCHoBWTTmz6sd/bflLB5yObRb566W'; // hash de "123456"

async function resetBase() {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    await conn.query('DELETE FROM compras');
    await conn.query('DELETE FROM arrendamentos');
    await conn.query('DELETE FROM favoritos');
    await conn.query('DELETE FROM livros   WHERE id NOT IN (1, 2)');
    await conn.query('DELETE FROM usuarios WHERE id NOT IN (1, 2, 3)');

    await conn.query(
      `INSERT INTO usuarios (id, nome, email, senha, tipo) VALUES
        (1, 'Admin Master',     'admin@biblioteca.com', ?, 3),
        (2, 'João Funcionário', 'func@biblio.com',      ?, 2),
        (3, 'Maria Aluna',      'aluna@teste.com',      ?, 1)
       ON DUPLICATE KEY UPDATE nome = VALUES(nome), email = VALUES(email), senha = VALUES(senha), tipo = VALUES(tipo)`,
      [SEED_PASSWORD_HASH, SEED_PASSWORD_HASH, SEED_PASSWORD_HASH]
    );

    await conn.query(
      `INSERT INTO livros (id, nome, autor, paginas, descricao, imagem_url, estoque, preco) VALUES
        (1, 'Clean Code',   'Robert C. Martin', 464, 'Um guia completo sobre boas práticas de programação',
         'https://images-na.ssl-images-amazon.com/images/I/41xShlnTZTL._SX376_BO1,204,203,200_.jpg', 5, 49.90),
        (2, 'Harry Potter', 'J.K. Rowling',     309, 'O primeiro livro da saga do bruxinho mais famoso',
         'https://m.media-amazon.com/images/I/81ibfYk4qmL._SY466_.jpg', 3, 39.90)
       ON DUPLICATE KEY UPDATE
         nome = VALUES(nome), autor = VALUES(autor), paginas = VALUES(paginas),
         descricao = VALUES(descricao), imagem_url = VALUES(imagem_url),
         estoque = VALUES(estoque), preco = VALUES(preco)`
    );

    await conn.commit();

    // ALTER TABLE é DDL e faz commit implícito — precisa ficar FORA da transação,
    // senão quebra a atomicidade do reset (root cause da race no dashboard).
    await conn.query('ALTER TABLE compras       AUTO_INCREMENT = 1');
    await conn.query('ALTER TABLE arrendamentos AUTO_INCREMENT = 1');
    await conn.query('ALTER TABLE livros        AUTO_INCREMENT = 3');
    await conn.query('ALTER TABLE usuarios      AUTO_INCREMENT = 4');

    console.log(`[reset] ${new Date().toISOString()} - estado inicial restaurado (3 usuários, 2 livros, 0 domínio)`);
    return true;
  } catch (err) {
    await conn.rollback();
    console.error('[reset] Erro:', err.message);
    return false;
  } finally {
    conn.release();
  }
}

/**
 * @swagger
 * /reset:
 *   post:
 *     summary: Restaura a base ao estado inicial (3 usuários, 2 livros, sem compras/arrendamentos/favoritos)
 *     tags: [Sistema]
 *     responses:
 *       200: { description: Base restaurada }
 *       500: { description: Falha ao restaurar, detalhe no log do servidor }
 */
app.post('/reset', async (req, res) => {
  const ok = await resetBase();
  if (ok) return res.json({ mensagem: 'Base restaurada ao estado inicial' });
  res.status(500).json({ mensagem: 'Falha ao restaurar a base' });
});

// Rota explícita além do express.static: a borda da Hostinger decide caminhos
// *.html sozinha e nunca entregou o reset.html novo, então a página também
// vive em GET /reset — caminho sem .html sempre chega ao app. Se o arquivo
// faltar na árvore, cai numa versão mínima embutida em vez de 404.
app.get(['/reset', '/reset.html'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'reset.html'), (err) => {
    if (!err) return;
    res.type('html').send(
      '<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>Reset - Biblioteca</title></head>' +
        '<body style="font-family:sans-serif;max-width:480px;margin:40px auto;text-align:center">' +
        '<h1>🔄 Reset da base</h1><p>Restaura a base ao estado inicial (3 usuários, 2 livros).</p>' +
        '<button onclick="fazerReset()">Restaurar estado inicial</button><p id="resultado"></p>' +
        '<script>async function fazerReset(){if(!confirm("Isto apaga todos os dados criados. Continuar?"))return;' +
        'const el=document.getElementById("resultado");el.textContent="Restaurando...";' +
        'try{const r=await fetch("/reset",{method:"POST"});const d=await r.json();el.textContent=d.mensagem;}' +
        'catch(e){el.textContent="Erro: "+e.message;}}</script></body></html>',
    );
  });
});

// ==================== SWAGGER ====================

const swaggerOptions = {
  definition: {
    openapi: '3.0.0',
    info: { title: 'API Biblioteca Pro Max', version: '3.0.0' },
    servers: [{ url: '/' }]
  },
  apis: ['./server.js']
};

const swaggerDocs = swaggerJsdoc(swaggerOptions);
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocs));

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Servidor rodando em http://localhost:${PORT}/login.html`);
    console.log(`Swagger: http://localhost:${PORT}/api-docs`);
  });

  // O LiteSpeed encerra o app com SIGTERM (deploy, restart, reciclagem). Sem
  // handler, instância presa só morre por SIGKILL e fica ocupando o limite de
  // processos da conta enquanto isso. Saída imediata de propósito: os dados
  // moram no MySQL e fechar o pool com query em voo é pior do que deixar o
  // sistema operacional recolher os sockets.
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
}

module.exports = app;
