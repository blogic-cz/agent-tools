export const REVIEW_THREADS_QUERY = `
  query($owner: String!, $name: String!, $pr: Int!, $after: String) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $pr) {
        reviewThreads(first: 100, after: $after) {
          nodes {
            id
            isResolved
            comments(first: 100) {
              nodes {
                id
                databaseId: fullDatabaseId
                path
                line
                body
                author { login }
                commit { oid }
              }
              pageInfo { hasNextPage endCursor }
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    }
  }
`;

export const REVIEW_THREAD_COMMENTS_QUERY = `
  query($threadId: ID!, $after: String) {
    node(id: $threadId) {
      ... on PullRequestReviewThread {
        comments(first: 100, after: $after) {
          nodes {
            id
            databaseId: fullDatabaseId
            path
            line
            body
            author { login }
            commit { oid }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
`;

export const RESOLVE_THREAD_MUTATION = `
  mutation($threadId: ID!) {
    resolveReviewThread(input: {threadId: $threadId}) {
      thread { id isResolved }
    }
  }
`;

export const PENDING_REVIEWS_QUERY = `
  query($owner: String!, $name: String!, $pr: Int!, $after: String) {
    viewer { login }
    repository(owner: $owner, name: $name) {
      pullRequest(number: $pr) {
        reviews(first: 100, after: $after, states: [PENDING]) {
          nodes {
            id
            state
            author { login }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
`;

export const PENDING_REVIEW_CONTENT_QUERY = `
  query($reviewId: ID!, $after: String) {
    viewer { login }
    node(id: $reviewId) {
      ... on PullRequestReview {
        id
        state
        body
        author { login }
        pullRequest {
          number
          repository { nameWithOwner }
        }
        comments(first: 100, after: $after) {
          nodes { body }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
`;

export const SUBMIT_REVIEW_MUTATION = `
  mutation($reviewId: ID!, $event: PullRequestReviewEvent!, $body: String) {
    submitPullRequestReview(input: { pullRequestReviewId: $reviewId, event: $event, body: $body }) {
      pullRequestReview { id state }
    }
  }
`;

export const LAST_HUMAN_REVIEWER_QUERY = `
  query($owner: String!, $name: String!, $pr: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $pr) {
        reviewRequests(first: 100) {
          nodes {
            requestedReviewer {
              __typename
              ... on User { login }
              ... on Team { name }
              ... on Bot { login }
            }
          }
        }
        reviews(last: 100) {
          nodes {
            author { login }
            state
            submittedAt
          }
        }
      }
    }
  }
`;

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

export type ThreadNode<DatabaseId = number> = {
  id: string;
  isResolved: boolean;
  comments: {
    nodes: Array<{
      id: string;
      databaseId: DatabaseId;
      path: string;
      line: number | null;
      body: string;
      author: { login: string };
      commit: { oid: string } | null;
    }>;
    pageInfo?: { hasNextPage: boolean; endCursor: string | null };
  };
};

export type ThreadCommentsQueryResult = {
  node: { comments: ThreadNode<string | null>["comments"] } | null;
};

export type ThreadsQueryResult = {
  repository: {
    pullRequest: {
      reviewThreads: {
        nodes: ThreadNode<string | null>[];
        pageInfo: {
          hasNextPage: boolean;
          endCursor: string | null;
        };
      };
    };
  };
};

export type ResolveThreadResult = {
  resolveReviewThread: {
    thread: { id: string; isResolved: boolean };
  };
};

export type PendingReviewsQueryResult = {
  viewer: { login: string };
  repository: {
    pullRequest: {
      reviews: {
        nodes: Array<{
          id: string;
          state: string;
          author: { login: string };
        }>;
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };
    };
  };
};

export type PendingReviewContentQueryResult = {
  viewer: { login: string };
  node: {
    id: string;
    state: string;
    body: string | null;
    author: { login: string };
    pullRequest: { number: number; repository: { nameWithOwner: string } };
    comments: {
      nodes: Array<{ body: string }>;
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
  } | null;
};

export type SubmitReviewResult = {
  submitPullRequestReview: {
    pullRequestReview: { id: string; state: string };
  };
};

export type RequestedReviewerNode = {
  __typename: string;
  login?: string;
  name?: string;
} | null;

export type LastHumanReviewerQueryResult = {
  repository: {
    pullRequest: {
      reviewRequests: {
        nodes: Array<{ requestedReviewer: RequestedReviewerNode }>;
      };
      reviews: {
        nodes: Array<{
          author: { login: string } | null;
          state: string;
          submittedAt: string | null;
        }>;
      };
    };
  };
};

export type RawReviewComment = {
  id: number;
  in_reply_to_id: number | null;
  user: { login: string };
  body: string;
  path: string;
  line: number | null;
  original_line?: number | null;
  original_commit_id?: string | null;
  diff_hunk?: string | null;
  created_at: string;
  updated_at: string;
  pull_request_review_id?: number | null;
  commit_id?: string | null;
};

export type RawIssueComment = {
  id: number;
  user: { login: string };
  body: string;
  created_at: string;
  html_url: string;
};

export type RawPullRequestReview = {
  id: number;
  user: { login: string } | null;
  state: string;
  body: string | null;
  submitted_at: string | null;
  html_url: string;
  commit_id?: string | null;
};

export type ReviewCommentById = {
  id: number;
  in_reply_to_id: number | null;
  pull_request_url: string;
};

export type EditableComment = {
  id: number;
  user: { login: string };
  html_url: string;
  updated_at: string;
  pull_request_url?: string;
  issue_url?: string;
};

export const REST_PAGE_SIZE = 100;
