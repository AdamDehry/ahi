const providers = {
  claude: {name:'Claude', company:'Anthropic', mark:'✳', package:'@anthropic-ai/claude-code', bin:'claude', login:['auth','login'], status:['auth','status'], guide:'https://code.claude.com/docs/en/setup', description:'Thoughtful conversation, writing, and building.'},
  codex: {name:'Codex', company:'OpenAI', mark:'◉', package:'@openai/codex', bin:'codex', login:['login'], status:['login','status'], guide:'https://developers.openai.com/codex/auth', description:'A capable partner for ideas and hands-on work.'},
  gemini: {name:'Gemini', company:'Google', mark:'✦', package:'@google/gemini-cli', bin:'gemini', login:[], status:null, guide:'https://geminicli.com/docs/get-started/authentication/', description:'Explore, reason, and build with Google’s models.'}
};
const voices = {
  openai:{name:'OpenAI', suggestion:'Recommended · mini realtime / text to speech', guide:'https://platform.openai.com/api-keys', env:'OPENAI_API_KEY', endpoint:'https://api.openai.com/v1/models', header:'Authorization', prefix:'Bearer '},
  elevenlabs:{name:'ElevenLabs', suggestion:'Expressive voices and voice design',guide:'https://elevenlabs.io/app/settings/api-keys',env:'ELEVENLABS_API_KEY',endpoint:'https://api.elevenlabs.io/v1/user',header:'xi-api-key',prefix:''},
  cartesia:{name:'Cartesia',suggestion:'Responsive, natural speech',guide:'https://play.cartesia.ai/keys',env:'CARTESIA_API_KEY',endpoint:'https://api.cartesia.ai/voices',header:'X-API-Key',prefix:''},
  gemini:{name:'Gemini',suggestion:'Google’s live audio and speech',guide:'https://aistudio.google.com/apikey',env:'GEMINI_API_KEY',endpoint:'https://generativelanguage.googleapis.com/v1beta/models',header:'x-goog-api-key',prefix:''}
};
const connections = ['gmail','calendar','drive','github','whatsapp'];
module.exports={providers,voices,connections};
