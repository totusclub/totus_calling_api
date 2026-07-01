const { wouldRepeatReply } = require('./conversation.health');

function verifyBeforeSend(conversation, reply, context = {}) {
  const issues = [];

  if (!reply || String(reply).trim().length < 3) {
    issues.push('empty_reply');
  }

  if (wouldRepeatReply(conversation, reply)) {
    issues.push('duplicate_reply');
  }

  if (context.intent?.primary === 'WHY_NO_RESULTS' && /нет подходящих туров/i.test(reply)) {
    const meta = conversation.meta || {};
    if ((meta.identical_reply_streak || 0) >= 1) {
      issues.push('stale_no_results_template');
    }
  }

  return {
    ok: issues.length === 0,
    issues,
    shouldEscalate: issues.includes('duplicate_reply') || issues.includes('stale_no_results_template'),
  };
}

module.exports = { verifyBeforeSend };
