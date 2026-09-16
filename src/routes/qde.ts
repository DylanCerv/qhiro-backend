import { Hono } from 'hono';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { adminMiddleware } from '../middleware/admin.js';
import {
  buildInputsFromParcel,
  defaultEnergyConfig,
  defaultProjectInputs,
  montePlataPreset,
  normalizeInputs,
  runQdeEngine,
  validateInputsForRun,
} from '../services/qde/engine.js';
import {
  createQdeProject,
  createQdeVersion,
  deleteQdeProject,
  getDefaultConfig,
  getDefaultCosts,
  getQdeProfiles,
  getQdeProject,
  getQdeProjects,
  getQdeVersion,
  getQdeVersions,
  markQdeVersionSelected,
  saveDefaultConfig,
  saveDefaultCosts,
  saveQdeVersionOutput,
  updateQdeProject,
  updateQdeVersionInputs,
} from '../services/qde/firestore-qde.js';
import { getParcel, getUserProfile } from '../services/firebase.js';

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

const energySchema = z.object({
  peonEffectiveRadiusM: z.number().positive(),
  cabecillaEffectiveRadiusM: z.number().positive(),
  nidoPumpMaxFlowLpm: z.number().positive(),
  nidoControlRadiusM: z.number().positive(),
  nidoSupplyVoltageV: z.number().positive(),
  minVoltageAtSentinelV: z.number().positive(),
  electricalLossPctPer100m: z.number().nonnegative(),
  pipePressureLossBarPer100m: z.number().nonnegative(),
  maxHydraulicReachM: z.number().positive(),
  // Opcionales para poder recalcular versiones creadas antes de que se
  // introdujeran estos límites; normalizeInputs aplica sus valores base.
  maxSentinelsPerNido: z.number().int().positive().optional().default(64),
  maxCabecillasPerNido: z.number().int().positive().optional().default(64),
  maxPeonesPerNido: z.number().int().positive().optional().default(64),
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
    species: z.string(),
    stage: z.string(),
    canopyHeightM: z.number().positive(),
    mission: z.string(),
  }),
  sprayProfile: sprayProfileSchema,
  constraints: z.object({
    minCoveragePct: z.number().min(50).max(100),
    maxSimultaneousHeads: z.number().int().min(1).max(64),
    minTerminalPressureBar: z.number().positive(),
  }),
  energy: energySchema.optional(),
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
  name: z.string().min(2).optional(),
  description: z.string().optional(),
  clientUserId: z.string().optional(),
  parcelId: z.string().optional(),
});

async function resolveClientParcel(clientUserId: string, parcelId: string) {
  const profile = await getUserProfile(clientUserId);
  if (!profile || profile.role !== 'client') {
    return { error: 'Client not found' as const };
  }
  const parcel = await getParcel(clientUserId, parcelId);
  if (!parcel) {
    return { error: 'Parcel not found for this client' as const };
  }
  return { profile, parcel };
}

const createVersionSchema = z.object({
  label: z.string().min(1),
  inputs: versionInputsSchema.optional(),
  parentVersionId: z.string().optional(),
  copyFromVersionId: z.string().optional(),
});

export const qdeRoutes = new Hono();

qdeRoutes.use('/*', authMiddleware, adminMiddleware);

qdeRoutes.get('/presets/monte-plata', (c) => c.json({ preset: montePlataPreset() }));

// Calcula un borrador de navegador sin alterar proyecto ni versión en Firestore.
qdeRoutes.post('/compute', async (c) => {
  const body = await c.req.json();
  const parsed = versionInputsSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid inputs payload', details: parsed.error.flatten() }, 400);
  }
  const inputs = normalizeInputs({ ...parsed.data, energy: parsed.data.energy ?? undefined });
  const validationError = validateInputsForRun(inputs);
  if (validationError) return c.json({ error: validationError }, 400);
  return c.json({ output: runQdeEngine(inputs) });
});

qdeRoutes.get('/settings/costs', async (c) => {
  const costs = await getDefaultCosts();
  return c.json({ costs });
});

qdeRoutes.put('/settings/costs', async (c) => {
  const body = await c.req.json();
  const parsed = versionInputsSchema.shape.costs.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid costs payload', details: parsed.error.flatten() }, 400);
  }
  const costs = await saveDefaultCosts(parsed.data);
  return c.json({ costs });
});

qdeRoutes.get('/settings/defaults', async (c) => {
  const defaults = await getDefaultConfig();
  return c.json({ defaults });
});

qdeRoutes.put('/settings/defaults', async (c) => {
  const body = await c.req.json();
  const parsed = z
    .object({
      costs: versionInputsSchema.shape.costs,
      energy: energySchema,
    })
    .safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid defaults payload', details: parsed.error.flatten() }, 400);
  }
  const defaults = await saveDefaultConfig({
    costs: parsed.data.costs,
    energy: parsed.data.energy ?? defaultEnergyConfig(),
  });
  return c.json({ defaults });
});

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

  let clientName: string | undefined;
  let parcelName: string | undefined;
  const baseDefaults = await getDefaultConfig();
  let inputs = normalizeInputs({
    ...defaultProjectInputs(baseDefaults.costs),
    energy: baseDefaults.energy,
  });

  if (parsed.data.parcelId) {
    if (!parsed.data.clientUserId) {
      return c.json({ error: 'Select a client when linking a parcel' }, 400);
    }
    const resolved = await resolveClientParcel(parsed.data.clientUserId, parsed.data.parcelId);
    if ('error' in resolved) {
      return c.json({ error: resolved.error }, 404);
    }
    clientName = resolved.profile.displayName;
    parcelName = resolved.parcel.name;
    inputs = normalizeInputs(buildInputsFromParcel(resolved.parcel));
    inputs.terrain.name = resolved.parcel.name;
    inputs.costs = { ...baseDefaults.costs, ...inputs.costs };
    inputs.energy = { ...baseDefaults.energy, ...inputs.energy };
  } else if (parsed.data.clientUserId) {
    const profile = await getUserProfile(parsed.data.clientUserId);
    if (!profile || profile.role !== 'client') {
      return c.json({ error: 'Client not found' }, 404);
    }
    clientName = profile.displayName;
  }

  inputs.costs = { ...baseDefaults.costs, ...inputs.costs };
  inputs.energy = { ...baseDefaults.energy, ...inputs.energy };

  const project = await createQdeProject({
    userId: user.uid,
    name: parsed.data.name ?? 'Nuevo plano',
    description: parsed.data.description,
    clientUserId: parsed.data.clientUserId,
    clientName,
    parcelId: parsed.data.parcelId,
    parcelName,
  });

  const version = await createQdeVersion({
    userId: user.uid,
    projectId: project.projectId,
    label: 'v1 — plano inicial',
    inputs,
  });

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
      clientUserId: z.string().nullable().optional(),
      parcelId: z.string().nullable().optional(),
      clientName: z.string().optional(),
      parcelName: z.string().optional(),
    })
    .safeParse(body);

  if (!parsed.success) {
    return c.json({ error: 'Invalid update payload', details: parsed.error.flatten() }, 400);
  }

  const patch: Record<string, unknown> = { ...parsed.data };
  if (patch.clientUserId === null || patch.clientUserId === '') {
    patch.clientUserId = undefined;
    patch.clientName = undefined;
    patch.parcelId = undefined;
    patch.parcelName = undefined;
  } else if (typeof patch.clientUserId === 'string') {
    const profile = await getUserProfile(patch.clientUserId);
    if (!profile || profile.role !== 'client') {
      return c.json({ error: 'Client not found' }, 404);
    }
    patch.clientName = profile.displayName;
  }

  if (patch.parcelId && typeof patch.clientUserId === 'string') {
    const resolved = await resolveClientParcel(patch.clientUserId, patch.parcelId as string);
    if ('error' in resolved) {
      return c.json({ error: resolved.error }, 404);
    }
    patch.parcelName = resolved.parcel.name;
  } else if (patch.parcelId === null || patch.parcelId === '') {
    patch.parcelId = undefined;
    patch.parcelName = undefined;
  }

  const project = await updateQdeProject(user.uid, c.req.param('projectId'), patch);
  if (!project) return c.json({ error: 'Project not found' }, 404);
  return c.json({ project });
});

qdeRoutes.post('/projects/:projectId/apply-parcel', async (c) => {
  const user = c.get('user');
  const projectId = c.req.param('projectId');
  const body = await c.req.json();
  const parsed = z
    .object({
      clientUserId: z.string().min(1),
      parcelId: z.string().min(1),
    })
    .safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid parcel payload', details: parsed.error.flatten() }, 400);
  }

  const project = await getQdeProject(user.uid, projectId);
  if (!project) return c.json({ error: 'Project not found' }, 404);

  const resolved = await resolveClientParcel(parsed.data.clientUserId, parsed.data.parcelId);
  if ('error' in resolved) {
    return c.json({ error: resolved.error }, 404);
  }

  const defaultCosts = await getDefaultCosts();
  const inputs = buildInputsFromParcel(resolved.parcel);
  inputs.terrain.name = resolved.parcel.name;
  inputs.costs = { ...defaultCosts, ...inputs.costs };

  const updatedProject = await updateQdeProject(user.uid, projectId, {
    clientUserId: parsed.data.clientUserId,
    clientName: resolved.profile.displayName,
    parcelId: parsed.data.parcelId,
    parcelName: resolved.parcel.name,
  });

  return c.json({ project: updatedProject, inputs });
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
    inputs: normalizeInputs(inputs),
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

  const updated = await updateQdeVersionInputs(
    user.uid,
    projectId,
    versionId,
    normalizeInputs({ ...parsed.data, energy: parsed.data.energy ?? undefined }),
  );
  if (!updated) return c.json({ error: 'Version not found' }, 404);
  return c.json({ version: updated });
});

qdeRoutes.post('/projects/:projectId/versions/:versionId/run', async (c) => {
  const user = c.get('user');
  const { projectId, versionId } = c.req.param();
  const version = await getQdeVersion(user.uid, projectId, versionId);
  if (!version) return c.json({ error: 'Version not found' }, 404);

  const inputs = normalizeInputs(version.inputs);
  const validationError = validateInputsForRun(inputs);
  if (validationError) {
    return c.json({ error: validationError }, 400);
  }

  const output = runQdeEngine(inputs);
  const saved = await saveQdeVersionOutput(user.uid, projectId, versionId, output);
  return c.json({ version: saved, output });
});

qdeRoutes.put('/projects/:projectId/versions/:versionId/output', async (c) => {
  const user = c.get('user');
  const { projectId, versionId } = c.req.param();
  const body = await c.req.json();
  if (!body?.output || !Array.isArray(body.output.deploymentNodes)) {
    return c.json({ error: 'Invalid manual layout payload' }, 400);
  }
  const saved = await saveQdeVersionOutput(user.uid, projectId, versionId, {
    ...body.output,
    summary: `${body.output.summary} Ajuste manual de posiciones pendiente de validación de campo.`,
  });
  if (!saved) return c.json({ error: 'Version not found' }, 404);
  return c.json({ version: saved });
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
  const body = await c.req.json().catch(() => ({}));
  const clientUserId =
    typeof body.clientUserId === 'string' ? body.clientUserId : undefined;

  const project = await getQdeProject(user.uid, projectId);
  if (!project) return c.json({ error: 'Project not found' }, 404);

  const ownerId = clientUserId ?? project.clientUserId;
  if (!ownerId) {
    return c.json({ error: 'Select a client before importing a parcel' }, 400);
  }

  const resolved = await resolveClientParcel(ownerId, parcelId);
  if ('error' in resolved) {
    return c.json({ error: resolved.error }, 404);
  }

  const inputs = buildInputsFromParcel(resolved.parcel);
  const version = await createQdeVersion({
    userId: user.uid,
    projectId,
    label: `Desde parcela — ${resolved.parcel.name}`,
    inputs,
  });

  await updateQdeProject(user.uid, projectId, {
    parcelId,
    clientUserId: ownerId,
    clientName: resolved.profile.displayName,
    parcelName: resolved.parcel.name,
  });

  return c.json({ version, inputs });
});
