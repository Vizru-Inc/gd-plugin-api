/**
 * Offline stand-in for the real ambient AI server, for local testing only.
 * Speaks the same Socket.IO v2 protocol as the integration guide, but returns
 * a canned dental consultation instead of transcribing the audio.
 *
 *   node fake-ambient-server.mjs            (listens on :4100)
 *   AMBIENT_SERVER_URL=http://localhost:4100 in .env (gd-api)
 */
import { createServer } from 'node:http';
import ioServer from 'socket.io-v2';

const PORT = Number(process.env.FAKE_AMBIENT_PORT ?? 4100);

// Script revealed progressively, one step per audio chunk.
const SCRIPT = [
  { speaker: 'doctor', text: 'Hi Maya, what brings you in today?' },
  { speaker: 'patient', text: 'My upper left back tooth hurts when I drink something cold, since about a week.' },
  { speaker: 'doctor', text: 'Any medications or allergies I should know about?' },
  { speaker: 'patient', text: 'I take ibuprofen sometimes, and I am allergic to penicillin, it gives me a rash.' },
  { speaker: 'doctor', text: 'Tooth 14 shows recurrent decay under the MO composite, and there is mild gingival inflammation.' },
  { speaker: 'doctor', text: 'We will replace the filling on 14 next week. Use Sensodyne twice a day and come back in seven days.' },
];

function buildOutput(step) {
  const has = (n) => step >= n;
  return {
    transcript: { entries: SCRIPT.slice(0, step) },
    clinical_data: {
      chiefComplaint: { value: has(2) ? 'Cold sensitivity in upper left back tooth for 1 week' : '' },
      historyOfPresentIllness: { value: has(2) ? 'Onset about 1 week ago; pain triggered by cold drinks.' : '' },
      medicalHistory: { value: '' },
      medications: { value: has(4) ? 'Ibuprofen as needed' : '' },
      allergies: { items: has(4) ? [{ allergen: 'Penicillin', reaction: 'Rash' }] : [] },
      toothFindings: {
        items: has(5) ? [{ tooth: '14', surfaces: 'MO', finding: 'Recurrent caries under existing composite' }] : [],
      },
      periodontal: { value: has(5) ? 'Mild generalized gingival inflammation' : '' },
      softTissue: { value: '' },
      radiographs: { value: '' },
      assessment: { value: has(5) ? 'Recurrent caries #14 MO' : '' },
      treatmentPlan: {
        items: has(6) ? [{ tooth: '14', procedure: 'Replace MO composite restoration', priority: 'next visit' }] : [],
      },
      proceduresPerformed: { items: [] },
      prescriptions: {
        items: has(6) ? [{ name: 'Sensodyne toothpaste', dosage: '', frequency: 'Twice daily', duration: '', instructions: 'For sensitivity' }] : [],
      },
      postOpInstructions: { value: '' },
      followUp: { value: has(6) ? 'Return in 7 days for restoration of #14' : '' },
      redFlags: { items: [] },
    },
  };
}

const httpServer = createServer();
const io = ioServer(httpServer);

io.of('/ambient').on('connection', (socket) => {
  let session = null;

  socket.on('init_ambient_session', (p = {}) => {
    if (!p.subscription_api_key) return socket.emit('error', { message: 'Invalid subscription API key' });
    if (!p.session_id || !p.prompt || !p.expected_output_json) {
      return socket.emit('error', { message: 'Missing required fields: session_id, prompt, expected_output_json' });
    }
    session = { id: p.session_id, step: 0, bytes: 0 };
    console.log(`[fake-ambient] session ${p.session_id} (prompt ${p.prompt.length} chars)`);
    socket.emit('connected', { message: 'ok', session_id: p.session_id, has_previous_transcription: false });
  });

  socket.on('ambient_process_audio', (p = {}) => {
    if (!session) return socket.emit('error', { message: 'Not an ambient session' });
    if (p.session_id !== session.id) return socket.emit('error', { message: 'Session ID mismatch' });
    const audio = p.audio_file;
    const bytes = typeof audio === 'string' ? Buffer.from(audio, 'base64') : Buffer.from(audio ?? []);
    const isWebm = bytes.subarray(0, 4).toString('hex') === '1a45dfa3';
    session.bytes += bytes.length;
    session.step = Math.min(SCRIPT.length, session.step + 1);
    console.log(`[fake-ambient] chunk ${bytes.length} B${isWebm ? ' (webm header)' : ''}${p.close_connection ? ' FINAL' : ''}`);

    setTimeout(() => {
      if (p.close_connection) {
        const final = buildOutput(SCRIPT.length);
        socket.emit('output_json', { session_id: session.id, output_json: final, timestamp: new Date().toISOString() });
        socket.emit('connection_closed', {
          session_id: session.id,
          s3_url: `https://example.invalid/ambient/${session.id}.webm`,
          final_output_json: final,
          timestamp: new Date().toISOString(),
        });
        session = null;
      } else {
        socket.emit('output_json', { session_id: session.id, output_json: buildOutput(session.step), timestamp: new Date().toISOString() });
      }
    }, 300);
  });
});

httpServer.listen(PORT, () => console.log(`[fake-ambient] Socket.IO v2 server on http://localhost:${PORT}/ambient`));
