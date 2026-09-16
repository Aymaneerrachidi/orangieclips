import { randomUUID } from 'node:crypto';
import { permissionsFor } from './permissions.js';

export function setupMembers(app, db, { auth, credentials, hashPassword, record }) {
  const manager = (req,res,next) => permissionsFor(req.user.role).manageClippers ? next() : res.status(403).json({error:'Account management access is required.'});
  const allowedRole = (actor, role) => (actor.role === 'owner' ? ['clipper','team','clipper_manager'] : ['clipper']).includes(role);
  app.get('/api/team', auth, async (req,res) => {
    const p=permissionsFor(req.user.role);
    if (!p.teamDirectory) return res.status(403).json({error:'Member directory access is required.'});
    res.json(await db.prepare(`SELECT id,name,role,active,created_at${p.manageClippers ? ',email' : ''} FROM users WHERE deleted_at IS NULL ${req.user.role==='clipper_manager' ? "AND role='clipper'" : ''} ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'team' THEN 1 ELSE 2 END,name`).all());
  });
  app.post('/api/team', auth, manager, async (req,res) => {
    try {
      const c=credentials(req.body); const role=req.body.role || 'clipper';
      if (!allowedRole(req.user,role)) return res.status(400).json({error:'You cannot assign that role.'});
      const id=randomUUID();
      await db.prepare('INSERT INTO users (id,name,email,password,role,created_at) VALUES (?,?,?,?,?,?)').run(id,c.name,c.email,hashPassword(c.password),role,new Date().toISOString());
      await record(req.user.id,id,null,'member.created',`${c.name} joined as ${role}`);
      res.status(201).json({id});
    } catch(e) {res.status(400).json({error:e.code==='23505'||e.message.includes('UNIQUE')?'That email already has an account.':e.message});}
  });
  // Lock the target before checking its role: a manager cannot race an owner promotion.
  async function change(req,res,action) {
    await db.exec('BEGIN IMMEDIATE');
    try {
      const member=await db.prepare(`SELECT * FROM users WHERE id=? AND deleted_at IS NULL${db.cloud?' FOR UPDATE':''}`).get(req.params.id);
      if (!member) {await db.exec('ROLLBACK');return res.status(404).json({error:'Member not found.'});}
      if (member.role==='owner' || (req.user.role!=='owner' && member.role!=='clipper')) {
        await db.exec('ROLLBACK');return res.status(req.user.role==='owner'?400:403).json({error:'You can only manage clipper accounts. Owner access is protected.'});
      }
      await action(member);
      await db.prepare('DELETE FROM sessions WHERE user_id=?').run(member.id);
      await db.exec('COMMIT');res.json({ok:true});
    } catch(e) {await db.exec('ROLLBACK');res.status(400).json({error:e.code==='23505'||e.message.includes('UNIQUE')?'That email already has an account.':e.message});}
  }
  app.patch('/api/team/:id',auth,manager,(req,res)=>change(req,res,async member=>{
    const role=req.body.role??member.role;const active=req.body.active??Boolean(member.active);
    if (!allowedRole(req.user,role)||typeof active!=='boolean') throw new Error('Choose a permitted role and account status.');
    const c=credentials({name:req.body.name??member.name,email:req.body.email??member.email,password:'validation-only-placeholder'});
    await db.prepare('UPDATE users SET name=?,email=?,role=?,active=? WHERE id=?').run(c.name,c.email,role,Number(active),member.id);
    await record(req.user.id,member.id,null,'member.updated',`${c.name}: ${role}, ${active?'active':'disabled'}`);
  }));
  app.post('/api/team/:id/password',auth,manager,(req,res)=>change(req,res,async member=>{
    credentials({...member,password:req.body.password});
    await db.prepare('UPDATE users SET password=? WHERE id=?').run(hashPassword(req.body.password),member.id);
    await record(req.user.id,member.id,null,'member.password_reset',`${member.name}'s password was reset`);
  }));
  app.delete('/api/team/:id',auth,manager,(req,res)=>change(req,res,async member=>{
    if(member.role!=='clipper') throw new Error('Only clipper accounts can be deleted.');
    await db.prepare('UPDATE users SET active=0,deleted_at=? WHERE id=?').run(new Date().toISOString(),member.id);
    await record(req.user.id,member.id,null,'member.deleted',`${member.name}'s account was deleted; uploaded clips retained`);
  }));
}
