import { Hono } from 'hono';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { adminMiddleware } from '../middleware/admin.js';
import { getParcel } from '../services/firebase.js';
import {
  buildInputsFromParcel,
  montePlataPreset,
  runQdeEngine,
} from '../services/qde/engine.js';
import {
  createQdeProject,
  createQdeVersion,
  deleteQdeProject,
  getQdeProfiles,
  getQdeProject,
  getQdeProjects,
  getQdeVersion,
  getQdeVersions,
  markQdeVersionSelected,
  saveQdeVersionOutput,
  updateQdeProject,
  updateQdeVersionInputs,
} from '../services/qde/firestore-qde.js';

const geoPointSchema = z.object({ lat: z.number(), lng: z.number() });

const sprayProfileSchema = z.object({
  profileId: z.string().min(1),
  label: z.string().min(1),
  version: z.string().min(1),
  ra: z.number().positive(),
  fo: z.number().min(0).max(0.9),
  pa: z.number().positive(),
  qa: z.number().positive(),
});

const versionInputsSchema = z.object({
  terrain: z.object({
    name: z.string().min(1),
    grossAreaHa: z.number().positive(),
    usefulAreaHa: z.number().positive(),
    coordinates: z.array(geoPointSchema).optional(),
    exclusions: z.array(z.array(geoPointSchema)).optional(),
  }),
  crop: z.object({
    species: z.string().min(1),
    stage: z.string().min(1),
    canopyHeightM: z.number().positive(),
    mission: z.string().min(1),
  }),
  sprayProfile: sprayProfileSchema,
  constraints: z.object({
    minCoveragePct: z.number().min(50).max(100),
    maxSimultaneousHeads: z.number().int().min(1).max(64),
    minTerminalPressureBar: z.number().positive(),
  }),
  costs: z.object({
    nidoUsd: z.number().nonnegative(),
    cabecillaUsd: z.number().nonnegative(),
    peonUsd: z.number().nonnegative(),
    qdnUsd: z.number().nonnegative(),
    pipePerMeterUsd: z.number().nonnegative(),
    installPerNodeUsd: z.number().nonnegative(),
  }),
  notes: z.string().optional(),
});

const createProjectSchema = z.object({
  name: z.string().min(2),
  description: z.string().optional(),
  parcelId: z.string().optional(),
  seedFromParcel: z.boolean().optional(),
  usePreset: z.boolean().optional(),
});

const createVersionSchema = z.object({
  label: z.string().min(1),
  inputs: versionInputsSchema.optional(),
  parentVersionId: z.string().optional(),
  copyFromVersionId: z.string().optional(),
});

export const qdeRoutes = new Hono();

qdeRoutes.use('/*', authMiddleware, adminMiddleware);

qdeRoutes.get('/presets/monte-plata', (c) => c.json({ preset: montePlataPreset() }));

qdeRoutes.get('/profiles', async (c) => {
  const profiles = await getQdeProfiles();
  return c.json({ profiles });
});

qdeRoutes.get('/projects', async (c) => {
  const user = c.get('user');
  const projects = await getQdeProjects(user.uid);
  return c.json({ projects });
});

qdeRoutes.post('/projects', async (c) => {
  const user = c.get('user');
  const body = await c.req.json();
  const parsed = createProjectSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid project payload', details: parsed.error.flatten() }, 400);
  }

  const project = await createQdeProject({
    userId: user.uid,
    name: parsed.data.name,
    description: parsed.data.description,
    parcelId: parsed.data.parcelId,
  });

  let version = null;
  if (parsed.data.usePreset || parsed.data.seedFromParcel) {
    let inputs = montePlataPreset();

    if (parsed.data.parcelId) {
      const parcel = await getParcel(user.uid, parsed.data.parcelId);
      if (!parcel) {
        return c.json({ error: 'Parcel not found for this user' }, 404);
      }
      inputs = buildInputsFromParcel(parcel);
    }

    version = await createQdeVersion({
      userId: user.uid,
      projectId: project.projectId,
      label: 'v1 — borrador inicial',
      inputs,
    });
  }

  return c.json({ project, version }, 201);
});

qdeRoutes.get('/projects/:projectId', async (c) => {
  const user = c.get('user');
  const project = await getQdeProject(user.uid, c.req.param('projectId'));
  if (!project) return c.json({ error: 'Project not found' }, 404);
  return c.json({ project });
});

qdeRoutes.put('/projects/:projectId', async (c) => {
  const user = c.get('user');
  const body = await c.req.json();
  const parsed = z
    .object({
      name: z.string().min(2).optional(),
      description: z.string().optional(),
      status: z.enum(['draft', 'active', 'archived']).optional(),
      parcelId: z.string().optional(),
    })
    .safeParse(body);

  if (!parsed.success) {
    return c.json({ error: 'Invalid update payload', details: parsed.error.flatten() }, 400);
  }

  const project = await updateQdeProject(user.uid, c.req.param('projectId'), parsed.data);
  if (!project) return c.json({ error: 'Project not found' }, 404);
  return c.json({ project });
});

qdeRoutes.delete('/projects/:projectId', async (c) => {
  const user = c.get('user');
  const deleted = await deleteQdeProject(user.uid, c.req.param('projectId'));
  if (!deleted) return c.json({ error: 'Project not found' }, 404);
  return c.json({ ok: true });
});

qdeRoutes.get('/projects/:projectId/versions', async (c) => {
  const user = c.get('user');
  const projectId = c.req.param('projectId');
  const project = await getQdeProject(user.uid, projectId);
  if (!project) return c.json({ error: 'Project not found' }, 404);

  const versions = await getQdeVersions(user.uid, projectId);
  return c.json({ versions });
});

qdeRoutes.post('/projects/:projectId/versions', async (c) => {
  const user = c.get('user');
  const projectId = c.req.param('projectId');
  const body = await c.req.json();
  const parsed = createVersionSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid version payload', details: parsed.error.flatten() }, 400);
  }

  const project = await getQdeProject(user.uid, projectId);
  if (!project) return c.json({ error: 'Project not found' }, 404);

  let inputs = parsed.data.inputs;
  let parentVersionId = parsed.data.parentVersionId;

  if (parsed.data.copyFromVersionId) {
    const source = await getQdeVersion(user.uid, projectId, parsed.data.copyFromVersionId);
    if (!source) return c.json({ error: 'Source version not found' }, 404);
    inputs = source.inputs;
    parentVersionId = source.versionId;
  }

  if (!inputs) {
    inputs = montePlataPreset();
  }

  const version = await createQdeVersion({
    userId: user.uid,
    projectId,
    label: parsed.data.label,
    inputs,
    parentVersionId,
  });

  return c.json({ version }, 201);
});

qdeRoutes.get('/projects/:projectId/versions/:versionId', async (c) => {
  const user = c.get('user');
  const { projectId, versionId } = c.req.param();
  const version = await getQdeVersion(user.uid, projectId, versionId);
  if (!version) return c.json({ error: 'Version not found' }, 404);
  return c.json({ version });
});

qdeRoutes.put('/projects/:projectId/versions/:versionId/inputs', async (c) => {
  const user = c.get('user');
  const { projectId, versionId } = c.req.param();
  const body = await c.req.json();
  const parsed = versionInputsSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid inputs payload', details: parsed.error.flatten() }, 400);
  }

  const updated = await updateQdeVersionInputs(user.uid, projectId, versionId, parsed.data);
  if (!updated) return c.json({ error: 'Version not found' }, 404);
  return c.json({ version: updated });
});

qdeRoutes.post('/projects/:projectId/versions/:versionId/run', async (c) => {
  const user = c.get('user');
  const { projectId, versionId } = c.req.param();
  const version = await getQdeVersion(user.uid, projectId, versionId);
  if (!version) return c.json({ error: 'Version not found' }, 404);

  const output = runQdeEngine(version.inputs);
  const saved = await saveQdeVersionOutput(user.uid, projectId, versionId, output);
  return c.json({ version: saved, output });
});

qdeRoutes.post('/projects/:projectId/versions/:versionId/select', async (c) => {
  const user = c.get('user');
  const { projectId, versionId } = c.req.param();
  const version = await markQdeVersionSelected(user.uid, projectId, versionId);
  if (!version) return c.json({ error: 'Version not found' }, 404);
  if (!version.output?.selectedAlternative) {
    return c.json({ error: 'Version has no feasible selected alternative' }, 400);
  }
  return c.json({ version });
});

qdeRoutes.post('/projects/:projectId/from-parcel/:parcelId', async (c) => {
  const user = c.get('user');
  const { projectId, parcelId } = c.req.param();
  const project = await getQdeProject(user.uid, projectId);
  if (!project) return c.json({ error: 'Project not found' }, 404);

  const parcel = await getParcel(user.uid, parcelId);
  if (!parcel) return c.json({ error: 'Parcel not found' }, 404);

  const inputs = buildInputsFromParcel(parcel);
  const version = await createQdeVersion({
    userId: user.uid,
    projectId,
    label: `Desde parcela — ${parcel.name}`,
    inputs,
  });

  await updateQdeProject(user.uid, projectId, { parcelId });
  return c.json({ version, inputs });
});
